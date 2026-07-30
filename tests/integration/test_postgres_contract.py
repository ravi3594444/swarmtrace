"""Postgres integration tests — guards the SDK ↔ API ↔ DB contract.

These tests spin up against a real Postgres instance (CI service container)
and verify that:

1. All `supabase/migrations/*.sql` apply cleanly in order.
2. The legacy `upsert_trace_with_metrics` RPC and the key-bound
   `upsert_trace_for_key` RPC (migration 0010 — used by `/api/ingest` and
   `/api/mcp`) accept the payload shape the Python SDK sends.
3. The RPC's `xmax = 0` idempotency trick actually works: retrying the
   same trace ID does NOT double-count `daily_metrics`. This is the
   atomic-ingest fix from migration 0007 — without it, SDK retries would
   inflate cost/tokens on the dashboard.
4. Every column the SDK sends (`kind`, `agent_id`, `agent_name`,
   `session_id`) exists in the `traces` schema. A migration that renames
   or drops one would silently break ingest.
5. The Phase 3 MCP fix shape round-trips: `kind='tool'` + explicit
   `agent_id` is stored correctly (the pre-Phase-3 hardcoded
   `kind='agent'` bug would have failed this).

WHY THIS EXISTS (the audit's Phase 4 recommendation):
  ci.yml previously ran `pytest` (mocked, no DB) + `tsc --noEmit`.
  Nothing spun up real Postgres, applied migrations, and hit the actual
  RPC. A migration could rename an RPC param, or a route could drift
  from what the SDK sends, and CI stayed green. The bugs were found by
  hand-testing — exactly the "fix one thing, break another" pattern
  this session hit 3 times (CLI crash, tree-view wrap, grandchild
  flattening). This test turns "found by hand" into "caught in CI".

SKIP BEHAVIOR:
  Auto-skipped when `POSTGRES_TEST_URL` env var is unset, so `pytest -q`
  in the existing CI step (and local dev) doesn't fail. The new
  `integration` CI job sets POSTGRES_TEST_URL and runs only this file.
  (Uses POSTGRES_TEST_URL instead of DATABASE_URL to avoid collision
  with the sandbox's DATABASE_URL which points at the SDK's SQLite file.)

USAGE:
  POSTGRES_TEST_URL=postgresql://postgres:postgres@localhost:5432/test \
      pytest tests/integration/test_postgres_contract.py -v
"""

from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path

import pytest

# ---------------------------------------------------------------------------
# Skip everything if no DB is configured. This lets the file live alongside
# the unit tests without breaking `pytest -q` in environments without Postgres.
# ---------------------------------------------------------------------------

POSTGRES_TEST_URL = os.environ.get("POSTGRES_TEST_URL")
pytestmark = pytest.mark.skipif(
    not POSTGRES_TEST_URL,
    reason="POSTGRES_TEST_URL not set — Postgres integration tests skipped. "
           "Run the `integration` CI job to exercise them.",
)

# Lazy import — psycopg2 is a test-only dep, not in the SDK's install_requires.
try:
    import psycopg2  # type: ignore
    from psycopg2.extras import RealDictCursor  # type: ignore
except ImportError:
    psycopg2 = None  # type: ignore
    pytestmark = pytest.mark.skipif(
        True, reason="psycopg2 not installed — run: pip install psycopg2-binary"
    )


MIGRATIONS_DIR = Path(__file__).resolve().parents[2] / "supabase" / "migrations"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def db_conn():
    """Connect to Postgres, apply all migrations, yield a connection.

    Migrations are applied once per module run (scope="module") to keep
    the test suite fast — the schema doesn't change between tests. Each
    test uses a transaction it rolls back at the end so tests are
    isolated.
    """
    conn = psycopg2.connect(POSTGRES_TEST_URL)
    # autocommit=True so each CREATE TABLE / DROP TABLE commits immediately
    # and migrations persist for the tests. Can't pass as a connect() kwarg —
    # psycopg2 rejects it with "invalid connection option 'autocommit'".
    conn.autocommit = True
    cur = conn.cursor()

    # Set up stubs for Supabase-specific dependencies before applying
    # migrations. The migrations assume they're running in a Supabase
    # project, which provides:
    #   - `auth` schema with jwt() + uid() functions (used in RLS policies)
    #   - `authenticated` + `service_role` roles (used in RLS TO clauses)
    #   - `supabase_realtime` publication (ALTER PUBLICATION in 0002/0004/0005)
    # Plain Postgres (CI service container) has none of these. The stubs
    # let the migrations apply as-is. RLS policies evaluate to NULL (no
    # rows visible via RLS), but the `postgres` superuser bypasses RLS, so
    # tests can still read/write all tables.
    cur.execute("""
        CREATE SCHEMA IF NOT EXISTS auth;
        CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb
            LANGUAGE sql AS $$SELECT NULL::jsonb$$;
        CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
            LANGUAGE sql AS $$SELECT NULL::uuid$$;
    """)
    # Roles can't be CREATEd with IF NOT EXISTS — use a DO block.
    cur.execute("""
        DO $$ BEGIN
            CREATE ROLE authenticated;
        EXCEPTION WHEN duplicate_object THEN NULL;
        END $$;
        DO $$ BEGIN
            CREATE ROLE service_role;
        EXCEPTION WHEN duplicate_object THEN NULL;
        END $$;
        DO $$ BEGIN
            CREATE PUBLICATION supabase_realtime;
        EXCEPTION WHEN duplicate_object THEN NULL;
        END $$;
    """)

    # Apply migrations in order. Each migration file is idempotent
    # (CREATE TABLE IF NOT EXISTS, CREATE OR REPLACE FUNCTION, etc.) so
    # re-running on a fresh DB is safe.
    migration_files = sorted(MIGRATIONS_DIR.glob("*.sql"))
    assert migration_files, f"No migrations found in {MIGRATIONS_DIR}"

    for migration_file in migration_files:
        sql = migration_file.read_text(encoding="utf-8")
        try:
            cur.execute(sql)
        except Exception as e:
            cur.close()
            conn.close()
            pytest.fail(
                f"Migration {migration_file.name} failed to apply: {e}\n"
                f"SQL:\n{sql[:500]}..."
            )

    cur.close()
    yield conn

    # Cleanup: drop all tables + functions + Supabase stubs so re-running
    # the suite is clean. (CI uses a fresh container per run, but this
    # makes local iteration safe.)
    cleanup_cur = conn.cursor()
    cleanup_cur.execute("""
        DROP TABLE IF EXISTS public.user_integrations CASCADE;
        DROP TABLE IF EXISTS public.agent_events CASCADE;
        DROP TABLE IF EXISTS public.daily_metrics CASCADE;
        DROP TABLE IF EXISTS public.api_keys CASCADE;
        DROP TABLE IF EXISTS public.traces CASCADE;
        DROP FUNCTION IF EXISTS public.upsert_trace_with_metrics CASCADE;
        DROP FUNCTION IF EXISTS public.upsert_trace_for_key CASCADE;
        DROP FUNCTION IF EXISTS public.insert_agent_event_for_key CASCADE;
        DROP FUNCTION IF EXISTS public.resolve_api_key_user_id CASCADE;
        DROP FUNCTION IF EXISTS public.upsert_trace CASCADE;
        DROP PUBLICATION IF EXISTS supabase_realtime;
        DROP FUNCTION IF EXISTS auth.jwt();
        DROP FUNCTION IF EXISTS auth.uid();
        DROP SCHEMA IF EXISTS auth CASCADE;
        DROP ROLE IF EXISTS service_role;
        DROP ROLE IF EXISTS authenticated;
    """)
    cleanup_cur.close()
    conn.close()


@pytest.fixture()
def clean_db(db_conn):
    """Per-test fixture: yields a cursor, rolls back everything after.

    Each test runs inside a transaction that gets rolled back, so tests
    don't see each other's data. The `db_conn` fixture uses
    autocommit=True for migration application, but for tests we want
    transactional isolation.
    """
    # autocommit is on at the connection level, so we manage a transaction
    # manually per test. Start by cleaning the traces + daily_metrics tables.
    cur = db_conn.cursor(cursor_factory=RealDictCursor)
    cur.execute("DELETE FROM public.traces;")
    cur.execute("DELETE FROM public.daily_metrics;")
    cur.execute("DELETE FROM public.agent_events;")
    cur.execute("DELETE FROM public.api_keys;")
    db_conn.commit()
    yield cur
    cur.execute("DELETE FROM public.traces;")
    cur.execute("DELETE FROM public.daily_metrics;")
    cur.execute("DELETE FROM public.agent_events;")
    cur.execute("DELETE FROM public.api_keys;")
    db_conn.commit()
    cur.close()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _trace_payload(
    trace_id: str = "test-trace-1",
    user_id: str = "test-user-1",
    function: str = "my_agent",
    kind: str = "agent",
    agent_id: str | None = None,
    agent_name: str | None = None,
    cost_usd: float = 0.001,
    input_tokens: int = 100,
    output_tokens: int = 50,
    timestamp: str | None = None,
) -> dict:
    """Build a payload matching what tracer.py::_enqueue_remote sends.

    Mirrors the field names the ingest route reads (row.kind, row.agent_id,
    etc.) so this test exercises the real contract.
    """
    if timestamp is None:
        timestamp = datetime.now(timezone.utc).isoformat()
    if agent_id is None:
        agent_id = trace_id
    if agent_name is None:
        agent_name = function
    return {
        "p_id": trace_id,
        "p_user_id": user_id,
        "p_parent_id": None,
        "p_function": function,
        "p_args": "('query',)",
        "p_output": "answer",
        "p_latency_sec": 0.5,
        "p_error": None,
        "p_timestamp": timestamp,
        "p_input_tokens": input_tokens,
        "p_output_tokens": output_tokens,
        "p_cost_usd": cost_usd,
        "p_kind": kind,
        "p_agent_id": agent_id,
        "p_agent_name": agent_name,
    }


def _call_rpc(cur, payload: dict) -> bool:
    """Call upsert_trace_with_metrics with the given payload.

    `clean_db` opens `cur` with `cursor_factory=RealDictCursor` (dict-like
    rows keyed by column name), so `fetchone()[0]` raises KeyError: 0 —
    there's no integer key 0 on a dict row. Alias the RPC result and pull
    it by name instead, matching every other fetch in this file.
    """
    cur.execute(
        "SELECT public.upsert_trace_with_metrics("
        "  %(p_id)s, %(p_user_id)s, %(p_parent_id)s, %(p_function)s, "
        "  %(p_args)s, %(p_output)s, %(p_latency_sec)s, %(p_error)s, "
        "  %(p_timestamp)s, %(p_input_tokens)s, %(p_output_tokens)s, "
        "  %(p_cost_usd)s, %(p_kind)s, %(p_agent_id)s, %(p_agent_name)s"
        ") AS was_insert;",
        payload,
    )
    return cur.fetchone()["was_insert"]


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_migrations_apply_cleanly(db_conn):
    """All migrations (0000 → latest) apply without error.

    If this fails, a new migration has a syntax error or references a
    table/column that doesn't exist yet. The fixture applies them in
    sorted order; this test just asserts the fixture didn't fail.
    """
    # If we got here, migrations applied. Verify the key tables exist.
    cur = db_conn.cursor()
    cur.execute("""
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
        ORDER BY table_name;
    """)
    tables = {row[0] for row in cur.fetchall()}
    cur.close()
    expected = {"traces", "daily_metrics", "api_keys", "agent_events", "user_integrations"}
    missing = expected - tables
    assert not missing, f"Missing tables after migrations: {missing}"


def test_traces_table_has_all_sdk_columns(clean_db):
    """The traces table must have every column the SDK sends.

    A migration that renames or drops `kind`, `agent_id`, `agent_name`,
    or `session_id` would silently break ingest — the RPC would fail or
    (worse) insert nulls. This test guards the SDK↔DB schema contract.
    """
    cur = clean_db
    cur.execute("""
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'traces'
        ORDER BY ordinal_position;
    """)
    columns = {row["column_name"] for row in cur.fetchall()}
    # Every field tracer.py::_enqueue_remote sends must exist.
    required = {
        "id", "user_id", "parent_id", "function", "args", "output",
        "latency_sec", "error", "timestamp",
        "input_tokens", "output_tokens", "cost_usd",
        "kind", "agent_id", "agent_name", "session_id",
    }
    missing = required - columns
    assert not missing, (
        f"traces table is missing columns the SDK sends: {missing}. "
        f"This would silently break ingest. Present columns: {columns}"
    )


def test_upsert_rpc_inserts_trace_correctly(clean_db):
    """upsert_trace_with_metrics inserts a trace with all fields preserved."""
    cur = clean_db
    payload = _trace_payload(
        trace_id="abc123",
        function="rag_agent",
        kind="agent",
        cost_usd=0.00234,
        input_tokens=120,
        output_tokens=45,
    )
    was_insert = _call_rpc(cur, payload)
    assert was_insert is True, "First call should be a fresh insert"

    cur.execute("SELECT * FROM public.traces WHERE id = 'abc123';")
    row = cur.fetchone()
    assert row is not None, "Trace not found after upsert"
    assert row["function"] == "rag_agent"
    assert row["kind"] == "agent"
    assert row["agent_id"] == "abc123"
    assert row["agent_name"] == "rag_agent"
    assert abs(row["cost_usd"] - 0.00234) < 1e-9
    assert row["input_tokens"] == 120
    assert row["output_tokens"] == 45


def test_rpc_is_idempotent_on_retry_no_double_count(clean_db):
    """Retrying the same trace ID does NOT double-count daily_metrics.

    This is the xmax=0 trick from migration 0007. The SDK retries failed
    POSTs up to 3x. If the RPC succeeds server-side but the HTTP response
    doesn't reach the client, the retry re-runs the RPC. Without the
    xmax=0 guard, daily_metrics would be incremented again — cost/tokens
    would be inflated on the dashboard.

    This test is the direct regression guard for the atomic-ingest fix.
    """
    cur = clean_db
    payload = _trace_payload(
        trace_id="retry-test-1",
        cost_usd=0.01,
        input_tokens=100,
        output_tokens=50,
    )

    # First call: fresh insert, metrics incremented.
    was_insert_1 = _call_rpc(cur, payload)
    assert was_insert_1 is True

    # Second call: same ID, simulating SDK retry. Should be an upsert
    # (no fresh insert), metrics NOT incremented.
    was_insert_2 = _call_rpc(cur, payload)
    assert was_insert_2 is False, (
        "Retry should report was_insert=False (xmax != 0). "
        "If this is True, the xmax=0 idempotency trick is broken — "
        "SDK retries would double-count cost/tokens on the dashboard."
    )

    # Verify daily_metrics has exactly one trace counted, not two.
    cur.execute(
        "SELECT trace_count, cost_usd, input_tokens, output_tokens "
        "FROM public.daily_metrics WHERE user_id = 'test-user-1';"
    )
    metrics = cur.fetchone()
    assert metrics is not None, "daily_metrics row should exist after first insert"
    assert metrics["trace_count"] == 1, (
        f"Expected trace_count=1 after retry, got {metrics['trace_count']}. "
        f"Double-counting bug is back."
    )
    assert abs(metrics["cost_usd"] - 0.01) < 1e-9
    assert metrics["input_tokens"] == 100
    assert metrics["output_tokens"] == 50


def test_phase3_mcp_kind_tool_with_agent_id_round_trips(clean_db):
    """Phase 3 fix: kind='tool' + explicit agent_id round-trips correctly.

    Pre-Phase-3, /api/mcp/route.ts:150 hardcoded `const kind = 'agent'`
    — every MCP trace got tagged 'agent' regardless. This test verifies
    the RPC itself preserves kind='tool' (the API route now passes it
    through via resolveTraceIdentity).
    """
    cur = clean_db
    payload = _trace_payload(
        trace_id="mcp-tool-1",
        function="search_web",
        kind="tool",
        agent_id="enclosing-agent-id",
        agent_name="Orchestrator",
    )
    was_insert = _call_rpc(cur, payload)
    assert was_insert is True

    cur.execute("SELECT * FROM public.traces WHERE id = 'mcp-tool-1';")
    row = cur.fetchone()
    assert row is not None
    assert row["kind"] == "tool", (
        f"Expected kind='tool' (Phase 3 fix), got kind={row['kind']!r}. "
        f"If this is 'agent', the kind is being hardcoded somewhere."
    )
    assert row["agent_id"] == "enclosing-agent-id"
    assert row["agent_name"] == "Orchestrator"


def test_phase3_retrieval_kind_round_trips(clean_db):
    """The 'retrieval' kind (added in Phase 3 for RAG) round-trips.

    kind is unconstrained TEXT in the DB, so this should just work —
    but testing it explicitly guards against a future CHECK constraint
    that doesn't include 'retrieval'.
    """
    cur = clean_db
    payload = _trace_payload(
        trace_id="rag-retrieval-1",
        function="qdrant_search",
        kind="retrieval",
        agent_id="rag-agent-1",
    )
    _call_rpc(cur, payload)

    cur.execute("SELECT kind FROM public.traces WHERE id = 'rag-retrieval-1';")
    row = cur.fetchone()
    assert row is not None
    assert row["kind"] == "retrieval"


def test_nested_spans_via_parent_id(clean_db):
    """A child span with parent_id round-trips, supporting trace trees.

    The CLI's tree view (`cli.py::view`) groups by parent_id to render
    the agent → tool/llm hierarchy. This test verifies parent_id is
    preserved through the RPC.
    """
    cur = clean_db
    # Parent agent span
    parent = _trace_payload(trace_id="parent-1", kind="agent")
    _call_rpc(cur, parent)

    # Child LLM span
    child = _trace_payload(
        trace_id="child-1",
        kind="llm",
        agent_id="parent-1",  # child rolls up into parent's agent_id
        function="call_mistral",
    )
    # _trace_payload doesn't have parent_id_arg, set it directly
    child["p_parent_id"] = "parent-1"
    _call_rpc(cur, child)

    cur.execute("SELECT id, parent_id, kind FROM public.traces ORDER BY id;")
    rows = cur.fetchall()
    assert len(rows) == 2
    by_id = {r["id"]: r for r in rows}
    assert by_id["parent-1"]["parent_id"] is None
    assert by_id["child-1"]["parent_id"] == "parent-1"
    assert by_id["child-1"]["kind"] == "llm"


def test_session_id_persists(clean_db):
    """session_id (migration 0008) round-trips for thread grouping.

    /threads page groups traces by session_id. If this column is dropped
    or renamed, threads break silently.
    """
    cur = clean_db
    payload = _trace_payload(trace_id="session-test-1")
    payload["p_session_id"] = "conv-123"  # type: ignore[assignment]
    # The current RPC signature doesn't take session_id — it's set via a
    # separate UPDATE or a different RPC. Verify the column exists and
    # can be written directly.
    _call_rpc(cur, payload)
    cur.execute(
        "UPDATE public.traces SET session_id = 'conv-123' WHERE id = 'session-test-1';"
    )
    cur.execute("SELECT session_id FROM public.traces WHERE id = 'session-test-1';")
    row = cur.fetchone()
    assert row is not None
    assert row["session_id"] == "conv-123"


# ---------------------------------------------------------------------------
# Migration 0010 — key-bound tenant isolation
# ---------------------------------------------------------------------------

def _seed_api_key(cur, *, key_hash: str = "a" * 64, user_id: str = "user-a") -> None:
    """Insert a non-revoked API key row for key-bound RPC tests."""
    cur.execute(
        """
        INSERT INTO public.api_keys (id, key_hash, key_prefix, user_id, name, revoked)
        VALUES (%s, %s, %s, %s, %s, false)
        ON CONFLICT (id) DO UPDATE SET
          key_hash = EXCLUDED.key_hash,
          user_id = EXCLUDED.user_id,
          revoked = false;
        """,
        (f"key-{key_hash[:8]}", key_hash, key_hash[:8], user_id, "test"),
    )


def _call_rpc_for_key(cur, payload: dict) -> bool:
    """Call upsert_trace_for_key (the production ingest/mcp path)."""
    cur.execute(
        "SELECT public.upsert_trace_for_key("
        "  %(p_key_hash)s, %(p_id)s, %(p_parent_id)s, %(p_function)s, "
        "  %(p_args)s, %(p_output)s, %(p_latency_sec)s, %(p_error)s, "
        "  %(p_timestamp)s, %(p_input_tokens)s, %(p_output_tokens)s, "
        "  %(p_cost_usd)s, %(p_kind)s, %(p_agent_id)s, %(p_agent_name)s,"
        "  %(p_session_id)s, %(p_trace_id)s, %(p_attributes)s"
        ") AS was_insert;",
        payload,
    )
    return cur.fetchone()["was_insert"]


def test_upsert_for_key_stamps_user_from_api_key(clean_db):
    """Tenant id comes from the API key inside Postgres — not from the caller."""
    cur = clean_db
    key_hash = "b" * 64
    _seed_api_key(cur, key_hash=key_hash, user_id="owner-42")

    payload = {
        "p_key_hash": key_hash,
        "p_id": "t-key-1",
        "p_parent_id": None,
        "p_function": "agent",
        "p_args": "()",
        "p_output": "ok",
        "p_latency_sec": 0.1,
        "p_error": None,
        "p_timestamp": datetime.now(timezone.utc).isoformat(),
        "p_input_tokens": 1,
        "p_output_tokens": 1,
        "p_cost_usd": 0.0,
        "p_kind": "agent",
        "p_agent_id": "t-key-1",
        "p_agent_name": "agent",
        "p_session_id": None,
        "p_trace_id": "t-key-1",
        "p_attributes": None,
    }
    assert _call_rpc_for_key(cur, payload) is True

    cur.execute("SELECT user_id FROM public.traces WHERE id = 't-key-1';")
    row = cur.fetchone()
    assert row is not None
    assert row["user_id"] == "owner-42"


def test_upsert_for_key_rejects_unknown_key(clean_db):
    """Unknown / revoked key_hash must fail — no orphan writes."""
    cur = clean_db
    payload = {
        "p_key_hash": "c" * 64,
        "p_id": "t-missing",
        "p_parent_id": None,
        "p_function": "agent",
        "p_args": "",
        "p_output": "",
        "p_latency_sec": 0.0,
        "p_error": None,
        "p_timestamp": datetime.now(timezone.utc).isoformat(),
        "p_input_tokens": 0,
        "p_output_tokens": 0,
        "p_cost_usd": 0.0,
        "p_kind": "agent",
        "p_agent_id": "t-missing",
        "p_agent_name": "agent",
        "p_session_id": None,
        "p_trace_id": None,
        "p_attributes": None,
    }
    try:
        _call_rpc_for_key(cur, payload)
        raised = False
    except Exception:
        raised = True
    assert raised, "expected invalid_api_key exception for unknown key"
    cur.execute("SELECT count(*) AS n FROM public.traces WHERE id = 't-missing';")
    assert cur.fetchone()["n"] == 0


def test_insert_agent_event_for_key_binds_tenant(clean_db):
    """FOV event inserts also stamp user_id from the API key."""
    cur = clean_db
    key_hash = "d" * 64
    _seed_api_key(cur, key_hash=key_hash, user_id="fov-user")
    cur.execute(
        "SELECT public.insert_agent_event_for_key("
        "  %s, %s, %s, %s, %s, %s, %s::jsonb, %s"
        ") AS id;",
        (
            key_hash,
            "evt-1",
            "agent-1",
            "browser",
            "info",
            "Agent",
            '{"url":"https://example.com"}',
            datetime.now(timezone.utc).isoformat(),
        ),
    )
    assert cur.fetchone()["id"] == "evt-1"
    cur.execute("SELECT user_id, event_type FROM public.agent_events WHERE id = 'evt-1';")
    row = cur.fetchone()
    assert row["user_id"] == "fov-user"
    assert row["event_type"] == "browser"
