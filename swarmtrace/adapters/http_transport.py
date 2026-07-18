"""HTTP transport for shipping trace spans to the remote ingest endpoint.

Implements the ``SpanTransport``-shaped contract used by the runtime. The
live background worker sends batches (gzip'd ``{"traces": [...]}``); the
resync CLI sends single rows. Both paths live here so ``tracer.py`` no
longer owns ``urllib`` request construction.
"""

from __future__ import annotations

import gzip
import json
from typing import Any, Dict, List
from urllib.request import Request, urlopen

from swarmtrace.span_model import SpanRecord


def _span_to_payload(span: SpanRecord) -> Dict[str, Any]:
    """Convert a canonical SpanRecord into the legacy /api/ingest payload shape."""
    payload: Dict[str, Any] = {
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


class HttpTransport:
    """Send trace payloads to ``{endpoint}/api/ingest`` over HTTPS."""

    def send(self, spans: List[SpanRecord], key: str, url: str) -> None:
        """Implement ``SpanTransport.send`` by mapping spans to ingest payloads."""
        payloads = [_span_to_payload(span) for span in spans]
        self.send_batch(payloads, key, url)

    def send_batch(self, payloads: List[dict], key: str, url: str) -> None:
        """Send a BATCH of traces as one gzip'd POST.

        Body shape: ``{"traces": [...]}``. gzip-compressed — trace payloads
        are highly compressible (args/output are repetitive text), so this
        typically shrinks wire bytes 5-10x.

        Raises on any HTTP error (the caller retries). The endpoint returns
        204 on success (no body) — we don't read it.
        """
        body = json.dumps({"traces": payloads}).encode()
        compressed = gzip.compress(body)
        req = Request(
            f"{url}/api/ingest",
            data=compressed,
            headers={
                "Content-Type": "application/json",
                "Content-Encoding": "gzip",
                "X-API-Key": key,
            },
            method="POST",
        )
        urlopen(req, timeout=10)  # batches take longer than single traces

    def send_single(self, payload: dict, key: str, url: str) -> None:
        """Send a SINGLE trace payload (legacy single-object shape).

        Used by the resync CLI, which replays one row at a time.
        """
        body = json.dumps(payload).encode()
        req = Request(
            f"{url}/api/ingest",
            data=body,
            headers={"Content-Type": "application/json", "X-API-Key": key},
            method="POST",
        )
        urlopen(req, timeout=5)
