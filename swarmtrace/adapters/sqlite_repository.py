"""SQLite adapter for the ``SpanRepository`` port.

This module wraps the existing ``storage.py`` functions in the
``SpanRepository`` protocol introduced in Phase 1. It is intentionally thin:
the durable SQLite logic, schema migration, and security checks remain in
``storage.py``; this adapter only translates between ``SpanRecord`` and the
legacy storage row shape.
"""

from __future__ import annotations

from typing import List

from swarmtrace.ports import SpanRepository
from swarmtrace.span_model import SpanRecord
from swarmtrace import storage


class SqliteRepository(SpanRepository):
    """Persist spans to the local SQLite outbox.

    All methods are safe to call from any thread: ``storage.py`` already owns
    the module-level lock and connection management.
    """

    def save(self, span: SpanRecord) -> None:
        """Insert or replace one span in the SQLite outbox."""
        storage.save_trace(**span.to_storage_dict())

    def get_children(self, span_id: str) -> List[SpanRecord]:
        """Return all direct children of ``span_id``.

        Rows are ordered by timestamp descending, newest first.
        """
        try:
            rows = storage.get_all_traces(limit=None)
        except Exception:
            return []
        return [
            SpanRecord.from_storage_row(row)
            for row in rows
            if row.get("parent_id") == span_id
        ]

    def mark_synced(self, span_id: str, synced: int = 1) -> None:
        """Set the synced flag for a single span row."""
        storage.mark_synced(span_id, synced)

    def get_unsynced(self, limit: int = 100) -> List[SpanRecord]:
        """Return up to ``limit`` unsynced spans, oldest first."""
        rows = storage.get_unsynced_traces(limit=limit)
        return [SpanRecord.from_storage_row(row) for row in rows]
