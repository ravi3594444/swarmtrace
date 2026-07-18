"""Core contracts (ports) for the SwarmTrace runtime.

These protocols define what the tracing core needs from storage and from
remote transport. They are introduced in Phase 0 so that Phase 1 can replace the
current module-level SQLite/HTTP code with adapters that implement these
contracts, without changing the public API.
"""

from __future__ import annotations

from typing import List, Optional, Protocol

from swarmtrace.span_model import SpanRecord


class SpanRepository(Protocol):
    """Persists spans locally and answers simple queries."""

    def save(self, span: SpanRecord) -> None:
        """Persist a span. Must be safe to call from any thread."""
        ...

    def get_children(self, span_id: str) -> List[SpanRecord]:
        """Return all direct children of ``span_id``."""
        ...

    def mark_synced(self, span_id: str, synced: int) -> None:
        """Mark a span as synced (1) or unsynced (0)."""
        ...

    def get_unsynced(self, limit: int) -> List[SpanRecord]:
        """Return up to ``limit`` unsynced spans for resync."""
        ...


class SpanTransport(Protocol):
    """Sends a batch of spans to the remote ingest endpoint."""

    def send(self, spans: List[SpanRecord]) -> None:
        """Send spans. Raises only on unrecoverable failure; callers retry."""
        ...


class Config(Protocol):
    """Read-only configuration for the runtime."""

    @property
    def api_key(self) -> Optional[str]: ...

    @property
    def endpoint(self) -> Optional[str]: ...

    @property
    def enabled(self) -> bool: ...
