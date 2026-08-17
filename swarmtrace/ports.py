"""Core contracts (ports) for the SwarmTrace runtime.

These protocols define what the tracing core needs from storage and from
remote transport. They are introduced in Phase 0 so that Phase 1 can replace the
current module-level SQLite/HTTP code with adapters that implement these
contracts, without changing the public API.
"""

from __future__ import annotations

from typing import Any, Protocol

from swarmtrace.span_model import SpanRecord


class SpanRepository(Protocol):
    """Persists spans locally and answers simple queries."""

    def save(self, span: SpanRecord) -> None:
        """Persist a span. Must be safe to call from any thread."""
        ...

    def get_children(self, span_id: str) -> list[SpanRecord]:
        """Return all direct children of ``span_id``."""
        ...

    def mark_synced(self, span_id: str, synced: int = 1) -> None:
        """Mark a span as synced (1) or unsynced (0).

        ``synced`` MUST have a default. The background sender's success path
        calls this with one argument (``mark_synced(payload["id"])``), so a
        repository declaring it as required raises ``TypeError`` inside the
        worker thread — which catches broad ``Exception`` and only logs. The
        symptom is silent: rows are delivered but never marked, so resync
        replays them forever. Every shipped implementation already defaults
        it; this signature now says so.
        """
        ...

    def get_unsynced(self, limit: int = 100) -> list[SpanRecord]:
        """Return up to ``limit`` unsynced spans for resync."""
        ...


class SpanTransport(Protocol):
    """Sends spans to the remote ingest endpoint.

    All three methods take ``key`` and ``url`` explicitly: the runtime resolves
    credentials lazily per call (``config()``), so a key rotated at runtime
    takes effect without rebuilding the transport.

    This protocol previously declared only ``send(spans)`` — a signature no
    implementation had and no caller used. The live sender drains through
    ``send_batch`` and the resync CLI through ``send_single``, so a transport
    written against the documented contract raised ``AttributeError`` in the
    background thread, where it was logged and swallowed. The contract now
    matches what the runtime actually calls.
    """

    def send(self, spans: list[SpanRecord], key: str, url: str) -> None:
        """Send canonical spans. Used by the OTLP collector's forward path."""
        ...

    def send_batch(self, payloads: list[dict[str, Any]], key: str, url: str) -> None:
        """Send a batch of ingest payloads — the background sender's hot path.

        Raises only on unrecoverable failure; the caller retries with backoff.
        """
        ...

    def send_single(self, payload: dict[str, Any], key: str, url: str) -> None:
        """Send one ingest payload. Used by the resync CLI, which replays rows."""
        ...


class Config(Protocol):
    """Read-only configuration for the runtime."""

    @property
    def api_key(self) -> str | None: ...

    @property
    def endpoint(self) -> str | None: ...

    @property
    def enabled(self) -> bool: ...
