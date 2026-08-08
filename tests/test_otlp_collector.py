"""Tests for the OTLP/HTTP collector."""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any

import pytest

from swarmtrace.adapters.http_transport import HttpTransport
from swarmtrace.otlp import OtlpCollector
from swarmtrace.span_model import SpanRecord


class FakeHttpTransport(HttpTransport):
    """Records batches instead of making real HTTP calls."""

    def __init__(self) -> None:
        self.batches: list[list[SpanRecord]] = []
        self.singles: list[dict[str, Any]] = []

    def send(self, spans: list[SpanRecord], key: str, url: str) -> None:
        self.batches.append(list(spans))

    def send_batch(self, payloads: list[dict], key: str, url: str) -> None:
        self.batches.append(payloads)

    def send_single(self, payload: dict, key: str, url: str) -> None:
        self.singles.append(payload)


@pytest.fixture
def collector(tmp_path):
    transport = FakeHttpTransport()
    seen: list[list[SpanRecord]] = []
    c = OtlpCollector(
        host="127.0.0.1",
        port=0,  # let OS choose a free port
        api_key="test-key",
        endpoint="https://example.test",
        transport=transport,
        on_spans=seen.append,
    )
    c.start()
    yield c, transport, seen
    c.stop()


def _url(collector):
    host, port = collector._server.server_address
    return f"http://{host}:{port}/v1/traces"


def _post(url: str, payload: dict) -> urllib.request.addinfourl:
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    return urllib.request.urlopen(req, timeout=5)


def test_collector_accepts_valid_otlp(collector):
    c, transport, seen = collector
    payload = {
        "resourceSpans": [
            {
                "resource": {
                    "attributes": [
                        {"key": "service.name", "value": {"stringValue": "test-agent"}}
                    ]
                },
                "scopeSpans": [
                    {
                        "spans": [
                            {
                                "traceId": "abc",
                                "spanId": "def",
                                "name": "do-thing",
                                "kind": 1,
                                "startTimeUnixNano": "1700000000000000000",
                                "endTimeUnixNano": "1700000001000000000",
                                "attributes": [],
                                "status": {"code": 1},
                            }
                        ]
                    }
                ],
            }
        ]
    }
    resp = _post(_url(c), payload)
    assert resp.status == 200
    data = json.loads(resp.read().decode("utf-8"))
    assert data["partialSuccess"]["rejectedSpans"] == 0

    # The on_spans hook should have received the mapped spans.
    assert len(seen) == 1
    assert len(seen[0]) == 1
    assert seen[0][0].name == "do-thing"

    # The transport should have received a batch.
    assert len(transport.batches) == 1
    assert len(transport.batches[0]) == 1


def test_collector_rejects_invalid_payload(collector):
    c, _transport, _seen = collector
    with pytest.raises(urllib.error.HTTPError) as exc_info:
        _post(_url(c), {"not": "valid"})
    assert exc_info.value.code == 400
    data = json.loads(exc_info.value.read().decode("utf-8"))
    assert "error" in data


def test_collector_rejects_unknown_path(collector):
    c, _transport, _seen = collector
    body = json.dumps({"resourceSpans": []}).encode("utf-8")
    req = urllib.request.Request(
        _url(c).replace("/v1/traces", "/v1/metrics"),
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with pytest.raises(urllib.error.HTTPError) as exc_info:
        urllib.request.urlopen(req, timeout=5)
    assert exc_info.value.code == 404


def test_collector_no_forward_without_config():
    c = OtlpCollector(host="127.0.0.1", port=0, api_key="", endpoint="")
    c.start()
    try:
        payload = {"resourceSpans": []}
        resp = _post(_url(c), payload)
        assert resp.status == 200
    finally:
        c.stop()
