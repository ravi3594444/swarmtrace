"""Canonical span/run data model for SwarmTrace.

This module defines the neutral ``SpanRecord`` that the tracing core, adapters,
and gateways all speak. It is deliberately free of I/O: it only describes what
a span *is*, not how it is stored or transported.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any


@dataclass
class SpanRecord:
    """One row in the agent history.

    A ``run()`` produces a span whose ``kind == "agent"``. A ``span()``
    produces a child span. The model is intentionally close to the existing
    ``traces`` SQLite table so the current repository can persist it without a
    schema change, while also carrying future fields such as ``trace_id`` and
    ``attributes``.
    """

    span_id: str
    name: str
    kind: str
    start_time: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    end_time: datetime | None = None
    status: str = "ok"
    parent_span_id: str | None = None
    trace_id: str | None = None
    agent_id: str | None = None
    agent_name: str | None = None
    session_id: str | None = None
    args: str | None = None
    output: str | None = None
    error: str | None = None
    latency_sec: float = 0.0
    input_tokens: int = 0
    output_tokens: int = 0
    cost_usd: float = 0.0
    attributes: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.end_time is not None and self.latency_sec == 0.0:
            self.latency_sec = round(
                (self.end_time - self.start_time).total_seconds(), 3
            )
        if self.trace_id is None:
            self.trace_id = self.span_id

    def to_storage_dict(self) -> dict[str, Any]:
        """Return kwargs for the ``storage.save_trace`` function.

        ``trace_id`` and ``attributes`` are included so the SQLite repository
        can store them once the Phase 5 migration adds the corresponding
        columns. Older callers that do not accept these keys can ignore them.
        """
        attrs = self.attributes
        return {
            "id_": self.span_id,
            "parent_id": self.parent_span_id,
            "trace_id": self.trace_id,
            "function": self.name,
            "args": self.args,
            "output": self.output,
            "latency_sec": self.latency_sec,
            "error": self.error,
            "timestamp": self.start_time.isoformat(),
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "cost_usd": self.cost_usd,
            "kind": self.kind,
            "agent_id": self.agent_id,
            "agent_name": self.agent_name,
            "session_id": self.session_id,
            "attributes": json.dumps(attrs) if attrs else None,
        }

    @classmethod
    def from_storage_row(cls, row: dict[str, Any]) -> SpanRecord:
        """Build a SpanRecord from a sqlite3.Row dict."""
        raw_attrs = row.get("attributes")
        attributes: dict[str, Any] = {}
        if isinstance(raw_attrs, str):
            try:
                attributes = json.loads(raw_attrs)
            except (json.JSONDecodeError, ValueError):
                attributes = {}
        elif isinstance(raw_attrs, dict):
            attributes = dict(raw_attrs)

        return cls(
            span_id=row["id"],
            parent_span_id=row.get("parent_id"),
            trace_id=row.get("trace_id"),
            name=row["function"],
            kind=row.get("kind", "agent"),
            start_time=datetime.fromisoformat(row["timestamp"]),
            latency_sec=row.get("latency_sec", 0.0),
            args=row.get("args"),
            output=row.get("output"),
            error=row.get("error"),
            input_tokens=row.get("input_tokens", 0) or 0,
            output_tokens=row.get("output_tokens", 0) or 0,
            cost_usd=row.get("cost_usd", 0.0) or 0.0,
            agent_id=row.get("agent_id"),
            agent_name=row.get("agent_name"),
            session_id=row.get("session_id"),
            attributes=attributes,
        )
