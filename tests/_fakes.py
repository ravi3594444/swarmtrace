"""Fakes for unit tests that drive the Phase 1 runtime seam.

These replace the old pattern of monkeypatching ``swarmtrace.tracer``
module internals (``save_trace``, ``_enqueue_remote``, ``_send_queue``,
worker flags). Tests now patch ``swarmtrace.runtime.get_runtime`` to return
a ``Runtime`` built from these fakes.
"""

from __future__ import annotations

from typing import Any

from swarmtrace.span_model import SpanRecord


class FakeRepository:
    """In-memory SpanRepository that records every saved span."""

    def __init__(self) -> None:
        self.spans: list[SpanRecord] = []
        self._synced: set[str] = set()

    def save(self, span: SpanRecord) -> None:
        self.spans.append(span)

    def get_children(self, span_id: str) -> list[SpanRecord]:
        return [s for s in self.spans if s.parent_span_id == span_id]

    def mark_synced(self, span_id: str, synced: int = 1) -> None:
        if synced:
            self._synced.add(span_id)
        else:
            self._synced.discard(span_id)

    def get_unsynced(self, limit: int = 100) -> list[SpanRecord]:
        return [s for s in self.spans[:limit] if s.span_id not in self._synced]

    def is_synced(self, span_id: str) -> bool:
        return span_id in self._synced


class FakeTransport:
    """Records every batch/single send; optionally raises to simulate failure."""

    def __init__(
        self,
        *,
        raise_on_batch: Exception | None = None,
        raise_on_single: Exception | None = None,
    ) -> None:
        self.batches: list[list[dict[str, Any]]] = []
        self.singles: list[dict[str, Any]] = []
        self.raise_on_batch = raise_on_batch
        self.raise_on_single = raise_on_single

    def send(self, spans: list[SpanRecord], key: str, url: str) -> None:
        """Implement ``SpanTransport.send`` by delegating to ``send_batch``.

        Uses the model's own mapping rather than an inline copy. The previous
        inline copy had silently drifted from the production one — it dropped
        ``session_id`` — which meant a session-id regression on the transport
        seam was invisible to every test that used this fake.
        """
        self.send_batch([span.to_ingest_payload() for span in spans], key, url)

    def send_batch(self, payloads: list[dict[str, Any]], key: str, url: str) -> None:
        if self.raise_on_batch is not None:
            raise self.raise_on_batch
        self.batches.append(list(payloads))

    def send_single(self, payload: dict[str, Any], key: str, url: str) -> None:
        if self.raise_on_single is not None:
            raise self.raise_on_single
        self.singles.append(payload)
