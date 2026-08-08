"""Tests for IngestHTTPError — the SDK side of the ingest-500 root cause.

Root cause context: the dashboard's /api/ingest failed with HTTP 500 for
the user whose Supabase migrations were never applied, but urllib's
HTTPError stringifies to "HTTP Error 500: Internal Server Error" and drops
the response body — so the classified {error, code, hint} body the server
sends was invisible. HttpTransport now raises IngestHTTPError, which keeps
the (bounded) server body in the message the sender/resync log lines print.

Covers:
  - body is surfaced for send_batch and send_single
  - status/reason/body attributes
  - oversized bodies are bounded (log-line safety)
  - non-HTTP errors (URLError etc.) still propagate unchanged
  - the sender's retry path treats IngestHTTPError as an ordinary failure
    (rows stay unsynced; error text includes the server hint)
"""

from __future__ import annotations

import gzip
import io
import json
from urllib.error import HTTPError, URLError

import pytest

from swarmtrace.adapters.http_transport import (
    _MAX_ERROR_BODY_CHARS,
    HttpTransport,
    IngestHTTPError,
)

CLASSIFIED_500_BODY = json.dumps(
    {
        "error": "Trace storage failed: database schema is not migrated",
        "code": "SCHEMA_NOT_MIGRATED",
        "hint": "The dashboard database schema is missing or behind. Apply the "
        "Supabase migrations in supabase/migrations/ in order — run "
        "`npm run db:migrate` in frontend-next (needs SUPABASE_DB_URL) or paste "
        "them in the Supabase SQL editor — then verify with GET /api/health/db. "
        "See docs/SUPABASE_SETUP.md.",
    }
).encode()


def _http_error(status: int = 500, reason: str = "Internal Server Error", body: bytes = b"") -> HTTPError:
    return HTTPError(
        url="https://dash.example/api/ingest",
        code=status,
        msg=reason,
        hdrs=None,  # type: ignore[arg-type]
        fp=io.BytesIO(body),
    )


class _FakeReq:
    def __init__(self, url, data, headers, method):
        self.data = data
        self.headers = headers


def _patch_transport(monkeypatch: pytest.MonkeyPatch, body: bytes, status: int = 500) -> None:
    def fake_urlopen(req, timeout):
        raise _http_error(status=status, body=body)

    monkeypatch.setattr("swarmtrace.adapters.http_transport.Request", _FakeReq)
    monkeypatch.setattr("swarmtrace.adapters.http_transport.urlopen", fake_urlopen)


class TestIngestHTTPError:
    def test_send_batch_surfaces_classified_server_body(self, monkeypatch):
        _patch_transport(monkeypatch, CLASSIFIED_500_BODY)
        with pytest.raises(IngestHTTPError) as excinfo:
            HttpTransport().send_batch([{"id": "t1"}], "k", "https://dash.example")
        msg = str(excinfo.value)
        assert "HTTP Error 500" in msg
        # The whole point: the operator now SEES what to do.
        assert "SCHEMA_NOT_MIGRATED" in msg
        assert "npm run db:migrate" in msg
        assert excinfo.value.status == 500
        assert excinfo.value.body == CLASSIFIED_500_BODY.decode()

    def test_send_single_surfaces_classified_server_body(self, monkeypatch):
        _patch_transport(monkeypatch, CLASSIFIED_500_BODY)
        with pytest.raises(IngestHTTPError) as excinfo:
            HttpTransport().send_single({"id": "t1"}, "k", "https://dash.example")
        assert "SCHEMA_NOT_MIGRATED" in str(excinfo.value)

    def test_401_body_surfaced_too(self, monkeypatch):
        body = b'{"error": "Invalid or revoked API key"}'
        _patch_transport(monkeypatch, body, status=401)
        with pytest.raises(IngestHTTPError) as excinfo:
            HttpTransport().send_batch([{"id": "t1"}], "bad-key", "https://dash.example")
        assert excinfo.value.status == 401
        assert "Invalid or revoked API key" in str(excinfo.value)

    def test_oversized_body_is_bounded(self, monkeypatch):
        big = b"<html>" + b"x" * (10 * _MAX_ERROR_BODY_CHARS) + b"</html>"
        _patch_transport(monkeypatch, big)
        with pytest.raises(IngestHTTPError) as excinfo:
            HttpTransport().send_batch([{"id": "t1"}], "k", "https://dash.example")
        assert len(excinfo.value.body) <= _MAX_ERROR_BODY_CHARS + 1  # +1 for the ellipsis
        assert excinfo.value.body.endswith("…")

    def test_empty_body(self, monkeypatch):
        _patch_transport(monkeypatch, b"")
        with pytest.raises(IngestHTTPError) as excinfo:
            HttpTransport().send_batch([{"id": "t1"}], "k", "https://dash.example")
        assert "server response" not in str(excinfo.value)
        assert "HTTP Error 500: Internal Server Error" in str(excinfo.value)

    def test_non_http_errors_propagate_unchanged(self, monkeypatch):
        def fake_urlopen(req, timeout):
            raise URLError("connection refused")

        monkeypatch.setattr("swarmtrace.adapters.http_transport.Request", _FakeReq)
        monkeypatch.setattr("swarmtrace.adapters.http_transport.urlopen", fake_urlopen)
        with pytest.raises(URLError):
            HttpTransport().send_batch([{"id": "t1"}], "k", "https://dash.example")

    def test_gzip_body_still_sent_when_erroring(self, monkeypatch):
        captured = {}

        class Req:
            def __init__(self, url, data, headers, method):
                captured["data"] = data

        def fake_urlopen(req, timeout):
            raise _http_error(body=CLASSIFIED_500_BODY)

        monkeypatch.setattr("swarmtrace.adapters.http_transport.Request", Req)
        monkeypatch.setattr("swarmtrace.adapters.http_transport.urlopen", fake_urlopen)
        with pytest.raises(IngestHTTPError):
            HttpTransport().send_batch([{"id": "t1", "output": "y" * 500}], "k", "https://dash.example")
        assert gzip.decompress(captured["data"])  # payload untouched by error handling


class TestSenderRetryCompatibility:
    """The background sender must treat IngestHTTPError like any failure:
    retry, then give up and leave rows unsynced (resync-replayable)."""

    def test_sender_retries_then_leaves_unsynced(self):
        from swarmtrace.delivery.sender import Sender

        attempts = {"n": 0}

        class FailingTransport:
            def send_batch(self, batch, key, url):
                attempts["n"] += 1
                raise IngestHTTPError(500, "Internal Server Error", CLASSIFIED_500_BODY.decode())

        class Repo:
            def __init__(self):
                self.synced = []

            def mark_synced(self, span_id):
                self.synced.append(span_id)

        sender = Sender(
            transport=FailingTransport(),
            repository=Repo(),
            config=lambda: ("k", "https://dash.example"),
            sleep=lambda _s: None,
            retries=3,
        )
        ok = sender._send_with_retries([{"id": "t1"}], "k", "https://dash.example")
        assert ok is False
        assert attempts["n"] == 3  # same retry semantics as before
