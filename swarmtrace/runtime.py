"""Canonical runtime seam that wires repository, transport, and sender.

Phase 1 introduces ``Runtime`` as the single integration point used by the
public tracing façade (``tracer.py``), the generic run/span API (``run.py``),
auto-instrumentation, and the optional tools. Tests can replace the whole
runtime with a fake repository + transport, eliminating the need to patch
private ``tracer.py`` internals.
"""

from __future__ import annotations

import logging
import time
from typing import Any, Callable, Dict, List, Optional, Tuple

from swarmtrace.delivery.sender import Sender
from swarmtrace.events import emit
from swarmtrace.ports import SpanRepository, SpanTransport
from swarmtrace.span_model import SpanRecord

_log = logging.getLogger("swarmtrace")

Config = Callable[[], Tuple[str, str]]


def _span_to_payload(span: SpanRecord) -> Dict[str, Any]:
    """Convert a canonical SpanRecord into the legacy /api/ingest payload shape."""
    payload = {
        "id": span.span_id,
        "parent_id": span.parent_span_id,
        "function": span.name,
        "args": span.args or "",
        "output": span.output or "",
        "latency_sec": span.latency_sec,
        "error": span.error,
        "timestamp": span.start_time.isoformat(),
        "input_tokens": span.input_tokens,
        "output_tokens": span.output_tokens,
        "cost_usd": span.cost_usd,
        "kind": span.kind,
        "agent_id": span.agent_id,
        "agent_name": span.agent_name,
    }
    if span.session_id is not None:
        payload["session_id"] = span.session_id
    if span.trace_id is not None and span.trace_id != span.span_id:
        payload["trace_id"] = span.trace_id
    if span.attributes:
        payload["attributes"] = span.attributes
    return payload


class Runtime:
    """Wires repository, transport, and sender behind one record/resync API.

    ``repository`` persists spans locally. ``transport`` sends them remotely.
    ``config`` returns ``(api_key, endpoint_url)`` lazily. ``sender`` (optional)
    drains the background queue; a default ``Sender`` is created if none is
    provided.
    """

    def __init__(
        self,
        repository: SpanRepository,
        transport: SpanTransport,
        config: Config,
        sender: Optional[Sender] = None,
    ) -> None:
        self._repository = repository
        self._transport = transport
        self._config = config
        self._sender = sender or Sender(transport, repository, config)

    @property
    def repository(self) -> SpanRepository:
        return self._repository

    @property
    def transport(self) -> SpanTransport:
        return self._transport

    @property
    def sender(self) -> Sender:
        return self._sender

    def record(self, span: SpanRecord) -> None:
        """Persist ``span`` locally and enqueue it for remote ingest."""
        self._repository.save(span)
        emit("span.recorded", span=span)
        self.enqueue_remote(span)

    def enqueue_remote(self, span: SpanRecord) -> None:
        """Enqueue a span for the background sender if remote is configured."""
        key, url = self._config()
        if not (key and url):
            return
        self._sender.enqueue(_span_to_payload(span))

    def resync(self, batch_size: int = 100, retries: int = 3) -> Tuple[int, int, int]:
        """Re-send unsynced spans to the remote endpoint one row at a time.

        Returns ``(attempted, succeeded, failed)``. If the remote endpoint is not
        configured, returns ``(0, 0, 0)``.
        """
        key, url = self._config()
        if not (key and url):
            return (0, 0, 0)

        spans = self._repository.get_unsynced(limit=batch_size)
        if not spans:
            return (0, 0, 0)

        attempted = len(spans)
        succeeded = 0
        failed = 0
        for span in spans:
            payload = _span_to_payload(span)
            sent_ok = False
            for attempt in range(retries):
                try:
                    self._transport.send_single(payload, key, url)
                    sent_ok = True
                    break
                except Exception as exc:
                    if attempt < retries - 1:
                        time.sleep(2 ** attempt)
                    else:
                        _log.error(
                            "resync: failed to send trace %s after %d attempts: %s",
                            span.span_id, retries, exc,
                        )
            if sent_ok:
                self._repository.mark_synced(span.span_id, 1)
                succeeded += 1
            else:
                failed += 1
        return (attempted, succeeded, failed)


# Module-level default runtime. Created lazily so import-time circular
# dependencies between runtime.py and tracer.py are avoided.
_runtime: Optional[Runtime] = None


def get_runtime() -> Runtime:
    """Return the current process runtime, creating the default one on first use."""
    global _runtime
    if _runtime is None:
        from swarmtrace.adapters.http_transport import HttpTransport
        from swarmtrace.adapters.sqlite_repository import SqliteRepository
        from swarmtrace.tracer import _remote_config

        _runtime = Runtime(
            SqliteRepository(),
            HttpTransport(),
            _remote_config,
        )
    return _runtime


def set_runtime(runtime: Optional[Runtime]) -> None:
    """Replace the process runtime (used by tests and custom wiring)."""
    global _runtime
    _runtime = runtime


def resync(batch_size: int = 100, retries: int = 3) -> Tuple[int, int, int]:
    """Public resync entrypoint used by the CLI.

    Returns ``(attempted, succeeded, failed)``.
    """
    return get_runtime().resync(batch_size=batch_size, retries=retries)
