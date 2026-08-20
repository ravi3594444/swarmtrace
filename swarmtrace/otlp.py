"""Lightweight OTLP/HTTP collector for SwarmTrace.

Receives OpenTelemetry trace data over HTTP/JSON at ``POST /v1/traces``,
maps it to canonical ``SpanRecord`` objects, and forwards each batch to the
configured SwarmTrace ``/api/ingest`` endpoint. This is a sidecar-style
collector: it runs as a separate process so agents that already export OTLP
can send to it without a SwarmTrace-specific SDK.

Usage::

    export SWARMTRACE_API_KEY="sk-..."
    export SWARMTRACE_ENDPOINT="https://app.swarmtrace.app"
    python -m swarmtrace.otlp --port 4318

The collector is intentionally minimal: it accepts HTTP/JSON only, validates
size and shape, redacts secrets, and forwards. For production workloads the
same mapping functions can be reused in a larger FastAPI/ASGI service.
"""

from __future__ import annotations

import json
import logging
import os
import threading
from collections.abc import Callable
from http.server import BaseHTTPRequestHandler, HTTPServer, ThreadingHTTPServer
from typing import Any

from swarmtrace.adapters.http_transport import HttpTransport
from swarmtrace.otlp_mapping import otlp_payload_to_span_records, validate_otlp_payload
from swarmtrace.span_model import SpanRecord

_log = logging.getLogger("swarmtrace.otlp")

# Bound the decompressed body size. OTLP batches can be large; 1 MB is enough
# for thousands of small spans.
MAX_BODY_BYTES = 1024 * 1024


def _default_api_key() -> str:
    return os.environ.get("SWARMTRACE_API_KEY", "")


def _default_endpoint() -> str:
    return os.environ.get("SWARMTRACE_ENDPOINT", "")


class OtlpCollectorHandler(BaseHTTPRequestHandler):
    """HTTP handler for OTLP trace ingestion."""

    transport: HttpTransport = HttpTransport()
    api_key: str = ""
    endpoint: str = ""
    on_spans: Callable[[list[SpanRecord]], None] | None = None

    def _send_json(self, status: int, body: Any) -> None:
        data = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _send_empty(self, status: int) -> None:
        self.send_response(status)
        self.end_headers()

    def do_POST(self) -> None:
        if self.path not in ("/v1/traces", "/v1/traces/"):
            self._send_json(404, {"error": "not found"})
            return

        length = self.headers.get("Content-Length")
        try:
            body_len = int(length) if length else 0
        except ValueError:
            self._send_json(400, {"error": "invalid Content-Length"})
            return

        if body_len > MAX_BODY_BYTES:
            self._send_json(413, {"error": "payload too large"})
            return

        try:
            body = self.rfile.read(body_len)
            payload = json.loads(body.decode("utf-8"))
        except Exception as exc:  # noqa: BLE001 -- HTTP handler boundary: any parse failure becomes a 400, must not crash the server thread
            _log.debug("failed to read body: %s", exc)
            self._send_json(400, {"error": "invalid JSON body"})
            return

        error = validate_otlp_payload(payload)
        if error:
            self._send_json(400, {"error": error})
            return

        try:
            spans = otlp_payload_to_span_records(payload)
        except Exception as exc:  # noqa: BLE001 -- HTTP handler boundary: any mapping failure becomes a 400
            _log.warning("failed to map OTLP spans: %s", exc)
            self._send_json(400, {"error": "failed to map spans"})
            return

        if self.on_spans is not None:
            try:
                self.on_spans(spans)
            except Exception as exc:  # noqa: BLE001 -- on_spans is arbitrary user code, must not crash the server thread
                _log.warning("on_spans hook failed: %s", exc)

        if self.api_key and self.endpoint:
            try:
                self.transport.send(spans, self.api_key, self.endpoint)
            except Exception as exc:  # noqa: BLE001 -- HTTP handler boundary: any forwarding failure becomes a 502
                _log.warning("failed to forward spans: %s", exc)
                self._send_json(502, {"error": "failed to forward spans"})
                return

        # OTLP success response shape.
        self._send_json(200, {
            "partialSuccess": {
                "rejectedSpans": 0,
                "errorMessage": "",
            }
        })

    def log_message(self, fmt: str, *args: Any) -> None:
        _log.debug(fmt, *args)


class OtlpCollector:
    """Runnable OTLP collector."""

    def __init__(
        self,
        host: str = "127.0.0.1",
        port: int = 4318,
        api_key: str | None = None,
        endpoint: str | None = None,
        transport: HttpTransport | None = None,
        on_spans: Callable[[list[SpanRecord]], None] | None = None,
    ) -> None:
        self.host = host
        self.port = port
        self.api_key = api_key or _default_api_key()
        self.endpoint = endpoint or _default_endpoint()
        self.transport = transport or HttpTransport()
        self.on_spans = on_spans
        self._server: HTTPServer | None = None
        self._thread: threading.Thread | None = None

    def _make_handler(self) -> type[BaseHTTPRequestHandler]:
        class _Handler(OtlpCollectorHandler):
            transport = self.transport
            api_key = self.api_key
            endpoint = self.endpoint
            on_spans = self.on_spans

        return _Handler

    def start(self) -> None:
        """Start the collector in a background thread."""
        if self._server is not None:
            return
        handler = self._make_handler()
        self._server = ThreadingHTTPServer((self.host, self.port), handler)
        self._thread = threading.Thread(
            target=self._server.serve_forever,
            daemon=True,
            name="swarmtrace-otlp",
        )
        self._thread.start()
        _log.info("OTLP collector listening on http://%s:%d/v1/traces", self.host, self.port)

    def stop(self) -> None:
        """Stop the collector."""
        if self._server is None:
            return
        self._server.shutdown()
        self._server.server_close()
        self._server = None
        self._thread = None

    def run(self) -> None:
        """Run the collector in the current thread (blocking)."""
        handler = self._make_handler()
        server = ThreadingHTTPServer((self.host, self.port), handler)
        _log.info("OTLP collector listening on http://%s:%d/v1/traces", self.host, self.port)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            _log.info("shutting down")
        finally:
            server.shutdown()
            server.server_close()


def main() -> None:
    """Console entry point: ``python -m swarmtrace.otlp``."""
    import argparse

    parser = argparse.ArgumentParser(description="SwarmTrace OTLP/HTTP collector")
    parser.add_argument("--host", default="127.0.0.1", help="bind host")
    parser.add_argument("--port", type=int, default=4318, help="bind port")
    parser.add_argument("--api-key", default=_default_api_key(), help="SwarmTrace API key")
    parser.add_argument("--endpoint", default=_default_endpoint(), help="SwarmTrace endpoint base URL")
    parser.add_argument("--log-level", default="INFO", help="log level")
    args = parser.parse_args()

    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    collector = OtlpCollector(
        host=args.host,
        port=args.port,
        api_key=args.api_key,
        endpoint=args.endpoint,
    )
    collector.run()


if __name__ == "__main__":
    main()
