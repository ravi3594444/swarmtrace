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

_log = logging.getLogger("swarmtrace")


class Sender:
    """Owns the background sender thread and its queue."""

    def __init__(
        self,
        transport,
        repository,
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

        self._queue: queue.Queue[dict] = queue.Queue(maxsize=queue_max)
        self._started = False
        # _lock guards the whole worker lifecycle: _started, _thread and
        # _stop_event always change together, under it. Never hold it across
        # a join() — enqueue() takes it on the traced application's hot path.
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        # Each worker gets its OWN stop event rather than sharing one on the
        # instance. With a shared flag, a start() that cleared it would revive
        # a previous worker still winding down out of a timed-out stop(),
        # leaving two workers draining one queue.
        self._stop_event: threading.Event | None = None

    # ------------------------------------------------------------------ queue

    def enqueue(self, payload: dict) -> None:
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

    def drain_batch(self, max_items: int, timeout: float) -> list[dict]:
        """Drain up to ``max_items`` payloads from the queue.

        Blocks until at least one item is available (so the worker doesn't
        spin), then drains any immediately-available items up to the cap.
        The ``timeout`` only applies to the FIRST item — once we have one,
        we drain non-blocking.
        """
        batch: list[dict] = []
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
            if self._started:
                return
            stop_event = threading.Event()
            thread = threading.Thread(
                target=self._run, args=(stop_event,), daemon=True, name=self._thread_name
            )
            # Publish the state BEFORE starting the thread and while still
            # holding the lock, so no concurrent stop() can observe a
            # half-built lifecycle (a live thread with _started still False,
            # which used to end as _started=True with _thread=None — a sender
            # that accepts payloads forever and never delivers one).
            self._thread = thread
            self._stop_event = stop_event
            self._started = True
            thread.start()

    def stop(self, timeout: float | None = 5.0) -> bool:
        """Ask the worker to finish its current batch and exit; join it.

        Returns ``True`` if the thread is gone by the time this returns.

        The worker used to be unstoppable: a daemon thread looping forever
        with no exit path. That is survivable in a long-lived app, but it
        leaves anything that tears its process state down — tests rotating
        the SQLite DB, an embedder swapping runtimes — with a live thread
        still writing through a connection the caller is about to close.
        That race segfaults the interpreter (see ``storage.close``), so the
        worker needs a way to be shut down before the DB goes away.

        The worker checks the stop flag once per loop, and its queue read
        blocks for at most ``batch_flush_timeout``, so it exits within
        roughly one flush interval. Anything still queued stays durable in
        SQLite and is picked up by ``swarmtrace-resync``.
        """
        with self._lock:
            thread = self._thread
            if self._stop_event is not None:
                self._stop_event.set()
            if thread is None:
                self._started = False
                return True

        # Join OUTSIDE the lock: a slow in-flight send would otherwise block
        # every enqueue() on the traced application's hot path for `timeout`.
        thread.join(timeout)
        alive = thread.is_alive()

        with self._lock:
            # `is thread` guards against clearing a NEWER worker that started
            # while we were joining the old one.
            if self._thread is thread and not alive:
                self._started = False
                self._thread = None
                self._stop_event = None
        return not alive

    def _run(self, stop_event: threading.Event) -> None:
        """Background send loop. Never dies — outer boundary logs and loops."""
        try:
            self._drain_until(stop_event)
        finally:
            # Worker-exit cleanup is AUTHORITATIVE. stop() can only tidy up
            # when its join() succeeds; if a send outlives the timeout the
            # worker exits later, and without this the sender was wedged
            # forever — _started stayed True, so start() short-circuited and
            # every subsequent span was queued and silently never delivered.
            with self._lock:
                if self._thread is threading.current_thread():
                    self._started = False
                    self._thread = None
                    self._stop_event = None

    def _drain_until(self, stop_event: threading.Event) -> None:
        """Drain and send batches until *stop_event* is set."""
        while not stop_event.is_set():
            batch: list[dict] = []
            try:
                batch = self.drain_batch(self._batch_max_items, self._batch_flush_timeout)
                if not batch:
                    continue
                key, url = self._config()
                if key and url and self._send_with_retries(batch, key, url):
                    for payload in batch:
                        self._repository.mark_synced(payload.get("id", ""))
            except Exception as exc:  # noqa: BLE001 -- daemon loop must never die, see docstring above
                _log.error("worker error (thread continues): %s", exc)
            finally:
                for _ in batch:
                    try:
                        self._queue.task_done()
                    except ValueError:
                        # Only raised if task_done() is called more times than
                        # items were get()'d; batch size always matches the
                        # get() calls in drain_batch(), so this should never
                        # fire. Logged at debug so it doesn't spam production
                        # but is visible if the invariant is ever violated.
                        _log.debug("task_done() called more times than queued items")

    def _send_with_retries(self, batch: list[dict], key: str, url: str) -> bool:
        """Send one batch; return True on confirmed success."""
        for attempt in range(self._retries):
            try:
                self._transport.send_batch(batch, key, url)
                return True
            except Exception as exc:  # noqa: BLE001 -- network transport failure, retried with backoff then logged
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
        self._thread = None
        self._stop_event = None
        self._queue = queue.Queue(maxsize=self._queue_max)
