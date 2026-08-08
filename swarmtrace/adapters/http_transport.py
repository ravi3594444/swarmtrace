"""HTTP transport for shipping trace spans to the remote ingest endpoint.

Implements the ``SpanTransport``-shaped contract used by the runtime. The
live background worker sends batches (gzip'd ``{"traces": [...]}``); the
resync CLI sends single rows. Both paths live here so ``tracer.py`` no
longer owns ``urllib`` request construction.
"""

from __future__ import annotations

import gzip
import json
from typing import Any
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from swarmtrace.span_model import SpanRecord

# Bound on how much of the server's error body we surface. The dashboard's
# classified error bodies are small JSON ({error, code, hint}); 2 KB covers
# them with margin while keeping an accidental HTML error page from flooding
# the log line.
_MAX_ERROR_BODY_CHARS = 2048


class IngestHTTPError(RuntimeError):
    """An /api/ingest HTTP failure that preserves the server's response body.

    Raised instead of ``urllib.error.HTTPError``. Callers (sender worker,
    resync CLI) catch broad ``Exception`` and log ``%s`` — urllib's HTTPError
    stringifies to just "HTTP Error 500: Internal Server Error", discarding
    the response body. The dashboard now returns classified bodies like
    ``{"error": "...", "code": "SCHEMA_NOT_MIGRATED", "hint": "...run the
    migrations..."}``; without the body, that remediation hint is invisible
    and a missing-migrations deployment is indistinguishable from an auth
    failure. This class exists to close that blind spot.
    """

    def __init__(self, status: int, reason: str, body: str) -> None:
        self.status = status
        self.reason = reason
        self.body = body
        detail = f" — server response: {body}" if body else ""
        super().__init__(f"HTTP Error {status}: {reason}{detail}")


def _ingest_error_from(err: HTTPError) -> IngestHTTPError:
    """Convert urllib's HTTPError into IngestHTTPError (with bounded body)."""
    try:
        body = err.read(_MAX_ERROR_BODY_CHARS + 1).decode("utf-8", errors="replace")
    except Exception:
        body = ""
    if len(body) > _MAX_ERROR_BODY_CHARS:
        body = body[:_MAX_ERROR_BODY_CHARS] + "…"
    return IngestHTTPError(err.code or 0, str(err.reason or ""), body)


def _span_to_payload(span: SpanRecord) -> dict[str, Any]:
    """Convert a canonical SpanRecord into the legacy /api/ingest payload shape."""
    payload: dict[str, Any] = {
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

    def send(self, spans: list[SpanRecord], key: str, url: str) -> None:
        """Implement ``SpanTransport.send`` by mapping spans to ingest payloads."""
        payloads = [_span_to_payload(span) for span in spans]
        self.send_batch(payloads, key, url)

    def send_batch(self, payloads: list[dict], key: str, url: str) -> None:
        """Send a BATCH of traces as one gzip'd POST.

        Body shape: ``{"traces": [...]}``. gzip-compressed — trace payloads
        are highly compressible (args/output are repetitive text), so this
        typically shrinks wire bytes 5-10x.

        Raises on any HTTP error (the caller retries) — HTTP errors are
        raised as IngestHTTPError, whose message includes the server's
        classified response body ({error, code, hint}). The endpoint returns
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
        try:
            urlopen(req, timeout=10)  # batches take longer than single traces
        except HTTPError as err:
            raise _ingest_error_from(err) from err

    def send_single(self, payload: dict, key: str, url: str) -> None:
        """Send a SINGLE trace payload (legacy single-object shape).

        Used by the resync CLI, which replays one row at a time. HTTP errors
        surface as IngestHTTPError (server response body preserved).
        """
        body = json.dumps(payload).encode()
        req = Request(
            f"{url}/api/ingest",
            data=body,
            headers={"Content-Type": "application/json", "X-API-Key": key},
            method="POST",
        )
        try:
            urlopen(req, timeout=5)
        except HTTPError as err:
            raise _ingest_error_from(err) from err
