"""Background sender — daemon worker draining a bounded queue into the transport.

Extracted from ``tracer.py`` (Phase 1.B). Behavior is intentionally
identical to the previous module-level worker: batch up to 20 payloads or
flush after 2 seconds (whichever first), gzip'd ``{"traces": [...]}`` POST,
3 attempts with 1s/2s exponential backoff, mark every trace in a confirmed
batch ``synced=1``, drop-on-full queue, and fork-safe state reset.

The transport, repository, config, and sleep are constructor-injected so
tests can drive this with fakes and a no-op sleep instead of patching
module globals.
"""

from __future__ import annotations

import logging
import queue
import threading
import time
from collections.abc import Callable
from typing import Any

from swarmtrace.ports import SpanRepository, SpanTransport

_log = logging.getLogger("swarmtrace")


class Sender:
    """Owns the background sender thread and its queue."""

    def __init__(
        self,
        transport: SpanTransport,
        repository: SpanRepository,
        config: Callable[[], tuple[str, str]],
        *,
        sleep: Callable[[float], None] = time.sleep,
        batch_max_items: int = 20,
        batch_flush_timeout: float = 2.0,
        queue_max: int = 1000,
        retries: int = 3,
        thread_name: str = "swarmtrace-sender",
    ) -> None:
        self._transport = transport
        self._repository = repository
        self._config = config
        self._sleep = sleep
        self._batch_max_items = batch_max_items
        self._batch_flush_timeout = batch_flush_timeout
        self._queue_max = queue_max
        self._retries = retries
        self._thread_name = thread_name

        self._queue: queue.Queue[dict[str, Any]] = queue.Queue(maxsize=queue_max)
        self._started = False
        self._lock = threading.Lock()

    # ------------------------------------------------------------------ queue

    def enqueue(self, payload: dict[str, Any]) -> None:
        """Drop a payload onto the queue for the worker to send.

        No-op when the remote endpoint isn't configured. Starts the worker
        thread on first use. A full queue drops the payload (never blocks
        the calling thread) — the row is already durable in SQLite.
        """
        key, url = self._config()
        if not (key and url):
            return
        self.start()
        try:
            self._queue.put_nowait(payload)
        except queue.Full:
            _log.error("ingest queue full — trace dropped")

    def drain_batch(self, max_items: int, timeout: float) -> list[dict[str, Any]]:
        """Drain up to ``max_items`` payloads from the queue.

        Blocks until at least one item is available (so the worker doesn't
        spin), then drains any immediately-available items up to the cap.
        The ``timeout`` only applies to the FIRST item — once we have one,
        we drain non-blocking.
        """
        batch: list[dict[str, Any]] = []
        try:
            first = self._queue.get(timeout=timeout)
            batch.append(first)
        except queue.Empty:
            return batch
        while len(batch) < max_items:
            try:
                batch.append(self._queue.get_nowait())
            except queue.Empty:
                break
        return batch

    # ----------------------------------------------------------------- worker

    def start(self) -> None:
        """Start the daemon sender thread exactly once."""
        if self._started:
            return
        with self._lock:
            if not self._started:
                threading.Thread(
                    target=self._run, daemon=True, name=self._thread_name
                ).start()
                self._started = True

    def _run(self) -> None:
        """Background send loop. Never dies — outer boundary logs and loops."""
        while True:
            batch: list[dict[str, Any]] = []
            try:
                batch = self.drain_batch(self._batch_max_items, self._batch_flush_timeout)
                if not batch:
                    continue
                key, url = self._config()
                if key and url and self._send_with_retries(batch, key, url):
                    for payload in batch:
                        self._repository.mark_synced(payload.get("id", ""))
            except Exception as exc:
                _log.error("worker error (thread continues): %s", exc)
            finally:
                for _ in batch:
                    try:
                        self._queue.task_done()
                    except Exception:
                        pass

    def _send_with_retries(self, batch: list[dict[str, Any]], key: str, url: str) -> bool:
        """Send one batch; return True on confirmed success."""
        for attempt in range(self._retries):
            try:
                self._transport.send_batch(batch, key, url)
                return True
            except Exception as exc:
                if attempt < self._retries - 1:
                    self._sleep(2 ** attempt)  # 1 s then 2 s
                else:
                    _log.error("remote ingest failed after %d attempts: %s", self._retries, exc)
        return False

    # ------------------------------------------------------------- fork safety

    def reset_after_fork(self) -> None:
        """Reset worker state in a forked child (audit finding #4).

        fork() clones ``_started = True`` but not the sender thread. Without
        this, the child's ``start()`` fast-path short-circuits forever and
        nothing ever drains. Also replace the queue — anything already queued
        belonged to a thread that only exists in the parent, and is already
        durable in SQLite.
        """
        self._started = False
        self._queue = queue.Queue(maxsize=self._queue_max)
