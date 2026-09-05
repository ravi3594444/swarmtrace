"""End-to-end tests for the whole local pipeline — no fakes.

Every other test in this suite substitutes something: ``tests/_fakes.py``
replaces the repository and the transport, ``test_batching.py`` drives the
``Sender`` with a stub, ``test_cli.py`` calls ``storage.save_trace`` directly.
That leaves the seams *between* those layers untested, which is exactly where
this project's shipped bugs have lived (the CLI's 14-vs-16 column unpack, the
grandchild-flattening tree, the "valid key, zero traces" ingest failure — all
shipped green).

These tests wire the real thing together:

    @observe'd functions
      → tracer._flush → SpanRecord
      → Runtime.record
      → SqliteRepository (a real SQLite file)
      → Sender (a real background thread)
      → HttpTransport (real gzip + urllib)
      → a real HTTP server on 127.0.0.1
      → back to mark rows synced=1
      → CLI view / export rendering the same DB

and assert what a user would see at each end. Nothing is mocked except the
dashboard itself, which is a genuine HTTP server here rather than a stub
object, so the gzip encoding, the ``{"traces": [...]}`` body shape, and the
``X-API-Key`` header are all really exercised.
"""

from __future__ import annotations

import contextlib
import gzip
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

import swarmtrace.storage as storage_module
from swarmtrace import cli, export
from swarmtrace import config as config_module
from swarmtrace.adapters.http_transport import HttpTransport
from swarmtrace.adapters.sqlite_repository import SqliteRepository
from swarmtrace.delivery.sender import Sender
from swarmtrace.runtime import Runtime, set_runtime
from swarmtrace.tracer import observe, session

# How long to wait for the background sender to deliver. The sender flushes
# every _FLUSH_TIMEOUT seconds, so this is generous by ~50x — long enough that
# a loaded CI runner won't flake, short enough that a genuine hang fails the
# test instead of hanging the suite.
_DELIVERY_TIMEOUT = 10.0
_FLUSH_TIMEOUT = 0.05


class _IngestServer:
    """A real HTTP server standing in for the dashboard's /api/ingest.

    Records every request it receives (path, headers, decoded body) so tests
    can assert on the actual wire format, and can be flipped into failing mode
    to simulate a dashboard outage.
    """

    def __init__(self) -> None:
        self.requests: list[dict] = []
        self.status = 204
        self._lock = threading.Lock()
        server_self = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.0"

            def do_POST(self) -> None:  # BaseHTTPRequestHandler's required name
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length)
                if self.headers.get("Content-Encoding") == "gzip":
                    raw = gzip.decompress(raw)
                with server_self._lock:
                    server_self.requests.append({
                        "path": self.path,
                        "api_key": self.headers.get("X-API-Key"),
                        "gzipped": self.headers.get("Content-Encoding") == "gzip",
                        "body": json.loads(raw.decode()),
                    })
                    status = server_self.status
                self.send_response(status)
                self.send_header("Content-Length", "0")
                self.end_headers()

            def log_message(self, *args) -> None:
                """Silence the default stderr access log."""

        self._httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self._httpd.server_address[1]}"
        self._thread = threading.Thread(target=self._httpd.serve_forever, daemon=True)
        self._thread.start()

    # -- assertions helpers -------------------------------------------------

    def spans(self) -> list[dict]:
        """Every span the server has received, flattened across requests."""
        out: list[dict] = []
        with self._lock:
            for req in self.requests:
                body = req["body"]
                out.extend(body.get("traces", [body]))
        return out

    def wait_for_spans(self, count: int, timeout: float = _DELIVERY_TIMEOUT) -> list[dict]:
        """Block until *count* spans have arrived, then return them."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            spans = self.spans()
            if len(spans) >= count:
                return spans
            time.sleep(0.02)
        raise AssertionError(
            f"timed out waiting for {count} spans; got {len(self.spans())}"
        )

    def stop(self) -> None:
        self._httpd.shutdown()
        self._httpd.server_close()


@pytest.fixture()
def ingest():
    server = _IngestServer()
    try:
        yield server
    finally:
        server.stop()


@pytest.fixture()
def pipeline(tmp_path, ingest, monkeypatch):
    """Wire the real SQLite + HTTP stack against a temp DB and the test server.

    Endpoint/key go through the environment and ``config.remote_config`` so
    the scheme validation and base-URL normalization run for real too — a
    hand-rolled ``lambda: (key, url)`` would skip both.
    """
    monkeypatch.setattr(storage_module, "DB_PATH", str(tmp_path / "e2e.db"))
    monkeypatch.setattr(storage_module, "_conn", None)
    monkeypatch.setattr(storage_module, "_write_count", 0)
    monkeypatch.setenv("SWARMTRACE_API_KEY", "st_e2e_key")
    monkeypatch.setenv("SWARMTRACE_ENDPOINT", ingest.url)
    config_module.clear_remote_config()

    repository = SqliteRepository()
    transport = HttpTransport()
    sender = Sender(
        transport,
        repository,
        config_module.remote_config,
        # No real backoff sleeps and a single attempt: the outage test wants
        # the failure path to resolve immediately, not 3 s later.
        sleep=lambda _seconds: None,
        batch_flush_timeout=_FLUSH_TIMEOUT,
        retries=1,
        thread_name="swarmtrace-sender-e2e",
    )
    runtime = Runtime(repository, transport, config_module.remote_config, sender)
    set_runtime(runtime)
    try:
        yield runtime
    finally:
        # Order matters: stop the worker BEFORE closing the connection it
        # writes through. Closing first is a use-after-free that takes the
        # whole interpreter down with SIGSEGV — that is how this pair of
        # APIs came to exist.
        assert sender.stop(timeout=5.0), "sender thread did not shut down"
        set_runtime(None)
        config_module.clear_remote_config()
        storage_module.close()


# ---------------------------------------------------------------------------
# The traced workload under test — a small RAG-shaped agent.
# ---------------------------------------------------------------------------

class _LLMResponse:
    """Stands in for an SDK response object carrying usage metadata."""

    def __init__(self, text: str) -> None:
        self.text = text
        self.input_tokens = 120
        self.output_tokens = 34
        self.model = "gpt-4o-mini"

    def __str__(self) -> str:
        return self.text


@observe(kind="tool")
def _search(query: str) -> list[str]:
    return [f"doc about {query}"]


@observe(kind="llm")
def _answer(prompt: str) -> _LLMResponse:
    return _LLMResponse(f"answer for {prompt}")


@observe(kind="tool")
def _broken_tool() -> None:
    raise ValueError("upstream tool exploded")


@observe
def _rag_agent(query: str) -> str:
    docs = _search(query)
    reply = _answer(f"{query} ctx={docs[0]}")
    with contextlib.suppress(ValueError):
        _broken_tool()
    return str(reply)


def _run_agent(query: str = "how do I install swarmtrace?") -> None:
    with session("session-e2e"):
        _rag_agent(query)


def _rows_by_function() -> dict[str, dict]:
    return {row["function"]: row for row in storage_module.get_traces(limit=50)}


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_observed_run_persists_the_whole_call_tree(pipeline):
    """Local SQLite must hold every span, correctly parented and attributed."""
    _run_agent()

    rows = _rows_by_function()
    assert set(rows) == {"_rag_agent", "_search", "_answer", "_broken_tool"}

    root = rows["_rag_agent"]
    assert root["parent_id"] is None
    assert root["kind"] == "agent"
    assert root["session_id"] == "session-e2e"

    for child in ("_search", "_answer", "_broken_tool"):
        assert rows[child]["parent_id"] == root["id"], f"{child} lost its parent"
        assert rows[child]["session_id"] == "session-e2e"
        # Children roll up under the enclosing agent, not their own identity.
        assert rows[child]["agent_id"] == root["agent_id"]

    assert rows["_search"]["kind"] == "tool"
    assert rows["_answer"]["kind"] == "llm"
    # Usage metadata is read off the returned response object and priced.
    assert rows["_answer"]["input_tokens"] == 120
    assert rows["_answer"]["output_tokens"] == 34
    assert rows["_answer"]["cost_usd"] > 0
    # A raising tool is recorded with its error, not dropped.
    assert "upstream tool exploded" in rows["_broken_tool"]["error"]
    assert rows["_rag_agent"]["error"] is None


def test_spans_reach_the_ingest_endpoint_and_are_marked_synced(pipeline, ingest):
    """The background sender must deliver every span and flip synced=1."""
    _run_agent()
    delivered = ingest.wait_for_spans(4)

    assert {span["function"] for span in delivered} == {
        "_rag_agent", "_search", "_answer", "_broken_tool",
    }

    # Wire format: gzip'd POST to /api/ingest with the key header and the
    # batch body shape the dashboard expects.
    for request in ingest.requests:
        assert request["path"] == "/api/ingest"
        assert request["api_key"] == "st_e2e_key"
        assert request["gzipped"], "batches must be gzip-compressed"
        assert "traces" in request["body"]

    by_function = {span["function"]: span for span in delivered}
    assert by_function["_search"]["parent_id"] == by_function["_rag_agent"]["id"]
    assert by_function["_search"]["session_id"] == "session-e2e"
    # Children share the distributed trace id of the root they hang off.
    assert by_function["_search"]["trace_id"] == by_function["_rag_agent"]["id"]

    # Every locally stored row is confirmed synced once the server has it.
    deadline = time.monotonic() + _DELIVERY_TIMEOUT
    while time.monotonic() < deadline:
        rows = storage_module.get_traces(limit=50)
        if rows and all(row["synced"] for row in rows):
            break
        time.sleep(0.02)
    unsynced = [row["function"] for row in storage_module.get_traces(limit=50)
                if not row["synced"]]
    assert not unsynced, f"delivered spans still marked unsynced: {unsynced}"


def test_secrets_in_arguments_are_redacted_before_they_leave_the_process(
    pipeline, ingest,
):
    """Redaction happens once, so SQLite and the wire agree — and neither leaks."""
    secret = "sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD"
    _run_agent(f"charge my key {secret} please")

    delivered = ingest.wait_for_spans(4)
    for span in delivered:
        assert secret not in json.dumps(span), f"secret leaked in {span['function']}"
    for row in storage_module.get_traces(limit=50):
        assert secret not in json.dumps(dict(row)), "secret leaked into local SQLite"


def test_endpoint_outage_leaves_rows_unsynced_and_resync_recovers_them(
    pipeline, ingest,
):
    """A dashboard outage must not lose traces: they stay queued for resync."""
    ingest.status = 500
    _run_agent()

    # Wait for the sender to have tried (and failed) on every span.
    ingest.wait_for_spans(4)
    deadline = time.monotonic() + 2.0
    while time.monotonic() < deadline and len(storage_module.get_traces(limit=50)) < 4:
        time.sleep(0.02)

    rows = storage_module.get_traces(limit=50)
    assert len(rows) == 4
    assert all(not row["synced"] for row in rows), (
        "rows were marked synced despite the endpoint returning 500"
    )

    # Dashboard comes back; resync replays the outbox one row at a time.
    ingest.status = 204
    before = len(ingest.spans())
    attempted, succeeded, failed = pipeline.resync(retries=1)

    assert (attempted, succeeded, failed) == (4, 4, 0)
    assert len(ingest.spans()) == before + 4
    assert all(row["synced"] for row in storage_module.get_traces(limit=50))

    # Resync is idempotent — a second run has nothing left to send.
    assert pipeline.resync(retries=1) == (0, 0, 0)


def test_cli_view_renders_the_recorded_run(pipeline, capsys):
    """`swarmtrace` must render the same run as a readable table + call tree."""
    _run_agent()
    cli.view(limit=50)
    out = capsys.readouterr().out

    assert "=== Agent Tree ===" in out, "rich rendering silently fell back to plain text"
    for function in ("_rag_agent", "_search", "_answer", "_broken_tool"):
        assert function in out

    tree = out.split("=== Agent Tree ===", 1)[1]
    assert "✓" in tree and "✗" in tree, "tree lost its per-span status markers"

    # The tree reads in execution order: search ran before the broken tool.
    assert tree.index("_search") < tree.index("_broken_tool"), (
        "tree siblings are rendered newest-first, against execution order"
    )
    # Children are nested under the agent, not flattened into siblings.
    assert "└──" in tree or "├──" in tree


def test_export_cli_writes_the_recorded_run_to_disk(pipeline, tmp_path, capsys):
    """`swarmtrace-export` must dump the same rows and say where they went."""
    _run_agent()

    destination = tmp_path / "export.json"
    assert export.main(["--format", "json", "--output", str(destination)]) == 0

    out = capsys.readouterr().out
    assert str(destination) in out, "export gave the user no confirmation"

    exported = json.loads(destination.read_text())
    assert {row["function"] for row in exported} == {
        "_rag_agent", "_search", "_answer", "_broken_tool",
    }
    # Every schema column survives the round trip.
    assert {"id", "parent_id", "kind", "session_id", "synced"} <= set(exported[0])
