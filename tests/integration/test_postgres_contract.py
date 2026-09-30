"""Postgres integration tests for the SDK <-> API <-> DB contract.

Runs against a real Postgres (the CI service container) and checks that:

1. every supabase/migrations/*.sql applies cleanly, in order
2. the `upsert_trace_with_metrics` and key-bound `upsert_trace_for_key` RPCs
   accept the payload shape the SDK sends
3. the `xmax = 0` idempotency trick holds: retrying a trace ID doesn't
   double-count daily_metrics
4. every column the SDK sends (kind, agent_id, agent_name, session_id) exists
5. kind='tool' with an explicit agent_id is stored as sent

Skipped unless POSTGRES_TEST_URL is set (not DATABASE_URL, which the SDK uses
for its own SQLite path). Usage:

  POSTGRES_TEST_URL=postgresql://postgres:postgres@localhost:5432/test \
      pytest tests/integration/test_postgres_contract.py -v
"""

from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path

import pytest

# skip the whole module when no DB is configured

POSTGRES_TEST_URL = os.environ.get("POSTGRES_TEST_URL")
pytestmark = pytest.mark.skipif(
    not POSTGRES_TEST_URL,
    reason="POSTGRES_TEST_URL not set — Postgres integration tests skipped. "
           "Run the `integration` CI job to exercise them.",
)

# Lazy import, psycopg2 is a test-only dep, not in the SDK's install_requires.
try:
    import psycopg2  # type: ignore
    from psycopg2.extras import RealDictCursor  # type: ignore
except ImportError:
    psycopg2 = None  # type: ignore
    pytestmark = pytest.mark.skipif(
        True, reason="psycopg2 not installed — run: pip install psycopg2-binary"
    )


MIGRATIONS_DIR = Path(__file__).resolve().parents[2] / "supabase" / "migrations"


# Fixtures

@pytest.fixture(scope="module")
def db_conn():
    """Connect to Postgres, apply all migrations once per module, yield a connection."""
    conn = psycopg2.connect(POSTGRES_TEST_URL)
    # autocommit=True so each CREATE TABLE / DROP TABLE commits immediately
    # and migrations persist for the tests. Can't pass as a connect() kwarg -
    # psycopg2 rejects it with "invalid connection option 'autocommit'".
    conn.autocommit = True
    cur = conn.cursor()

    # Migrations assume a Supabase project: an `auth` schema (jwt(), uid()), the anon/
    # authenticated/service_role roles, and a supabase_realtime publication. Plain
    # Postgres has none of those, so stub them. RLS then evaluates to NULL, but the
    # postgres superuser bypasses it.
    cur.execute("""
        CREATE SCHEMA IF NOT EXISTS auth;
        CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb
            LANGUAGE sql AS $$SELECT NULL::jsonb$$;
        CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
            LANGUAGE sql AS $$SELECT NULL::uuid$$;
    """)
    # Roles can't be CREATEd with IF NOT EXISTS, use a DO block.
    cur.execute("""
        DO $$ BEGIN
            CREATE ROLE anon;
        EXCEPTION WHEN duplicate_object THEN NULL;
        END $$;
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

    # migrations are idempotent, so re-running on a fresh DB is fine
    migration_files = sorted(MIGRATIONS_DIR.glob("*.sql"))
    assert migration_files, f"No migrations found in {MIGRATIONS_DIR}"

    for migration_file in migration_files:
        sql = migration_file.read_text(encoding="utf-8")
        try:
            cur.execute(sql)
        except Exception as e:  # noqa: BLE001 -- test fixture: catch any migration failure to clean up + pytest.fail
            cur.close()
            conn.close()
            pytest.fail(
                f"Migration {migration_file.name} failed to apply: {e}\n"
                f"SQL:\n{sql[:500]}..."
            )

    cur.close()
    yield conn

    # drop everything so local re-runs start clean
    cleanup_cur = conn.cursor()
    cleanup_cur.execute("""
        DROP TABLE IF EXISTS public.regression_runs CASCADE;
        DROP TABLE IF EXISTS public.user_integrations CASCADE;
        DROP TABLE IF EXISTS public.agent_events CASCADE;
        DROP TABLE IF EXISTS public.daily_metrics CASCADE;
        DROP TABLE IF EXISTS public.api_keys CASCADE;
        DROP TABLE IF EXISTS public.traces CASCADE;
        DROP FUNCTION IF EXISTS public.insert_regression_run_for_key CASCADE;
        DROP FUNCTION IF EXISTS public.upsert_trace_with_metrics CASCADE;
        DROP FUNCTION IF EXISTS public.upsert_trace_for_key CASCADE;
        DROP FUNCTION IF EXISTS public.insert_agent_event_for_key CASCADE;
        DROP FUNCTION IF EXISTS public.resolve_api_key_user_id CASCADE;
        DROP FUNCTION IF EXISTS public.upsert_trace CASCADE;
        DROP FUNCTION IF EXISTS public.increment_daily_metrics CASCADE;
        DROP PUBLICATION IF EXISTS supabase_realtime;
        DROP FUNCTION IF EXISTS auth.jwt() CASCADE;
        DROP FUNCTION IF EXISTS auth.uid() CASCADE;
        DROP SCHEMA IF EXISTS auth CASCADE;
        -- Migrations intentionally grant RPC execution to these Supabase
        -- roles. Revoke every remaining grant before dropping the test-only
        -- role stubs so a newly added RPC cannot break fixture teardown.
        DROP OWNED BY service_role;
        DROP OWNED BY authenticated;
        DROP OWNED BY anon;
        DROP ROLE IF EXISTS service_role;
        DROP ROLE IF EXISTS authenticated;
        DROP ROLE IF EXISTS anon;
    """)
    cleanup_cur.close()
    conn.close()


@pytest.fixture()
def clean_db(db_conn):
    """Yield a cursor inside a transaction that is rolled back after the test."""
    # autocommit is on, so manage a transaction by hand; start by clearing traces + daily_metrics
    cur = db_conn.cursor(cursor_factory=RealDictCursor)
    cur.execute("DELETE FROM public.traces;")
    cur.execute("DELETE FROM public.daily_metrics;")
    cur.execute("DELETE FROM public.agent_events;")
    cur.execute("DELETE FROM public.regression_runs;")
    cur.execute("DELETE FROM public.api_keys;")
    db_conn.commit()
    yield cur
    cur.execute("DELETE FROM public.traces;")
    cur.execute("DELETE FROM public.daily_metrics;")
    cur.execute("DELETE FROM public.agent_events;")
    cur.execute("DELETE FROM public.regression_runs;")
    cur.execute("DELETE FROM public.api_keys;")
    db_conn.commit()
    cur.close()


# Helpers

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
    """Build a payload matching what tracer.py::_enqueue_remote sends."""
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

    `cur` is a RealDictCursor, so the RPC result is aliased and fetched by name.
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


# Tests

def test_migrations_apply_cleanly(db_conn):
    """All migrations apply without error."""
    # the fixture already applied them; check the key tables exist
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
    """The traces table has every column the SDK sends."""
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
    """Retrying the same trace ID must not double-count daily_metrics (xmax=0 trick, migration 0007)."""
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
    """kind='tool' with an explicit agent_id round-trips through the RPC."""
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
        f"Expected kind='tool', got kind={row['kind']!r}. "
        f"If this is 'agent', the kind is being hardcoded somewhere."
    )
    assert row["agent_id"] == "enclosing-agent-id"
    assert row["agent_name"] == "Orchestrator"


def test_phase3_retrieval_kind_round_trips(clean_db):
    """The 'retrieval' kind round-trips (kind is unconstrained TEXT)."""
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
    """A child span keeps its parent_id, which the CLI tree view relies on."""
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
    """session_id (migration 0008) round-trips for thread grouping."""
    cur = clean_db
    payload = _trace_payload(trace_id="session-test-1")
    payload["p_session_id"] = "conv-123"  # type: ignore[assignment]
    # the RPC doesn't take session_id; just check the column can be written directly
    _call_rpc(cur, payload)
    cur.execute(
        "UPDATE public.traces SET session_id = 'conv-123' WHERE id = 'session-test-1';"
    )
    cur.execute("SELECT session_id FROM public.traces WHERE id = 'session-test-1';")
    row = cur.fetchone()
    assert row is not None
    assert row["session_id"] == "conv-123"


# Migration 0010, key-bound tenant isolation

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
    """Tenant id comes from the API key inside Postgres, not from the caller."""
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
    """Unknown / revoked key_hash must fail, no orphan writes."""
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
    except Exception:  # noqa: BLE001 -- test wants "any exception" for an invalid key, not a specific type
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


def test_insert_regression_run_for_key_binds_tenant_and_round_trips(clean_db):
    """The /api/regression write path: key_hash → user_id stamped inside
    Postgres, and the SDK payload round-trips (migration 0011)."""
    cur = clean_db
    key_hash = "e" * 64
    _seed_api_key(cur, key_hash=key_hash, user_id="reg-user")

    cur.execute(
        "SELECT public.insert_regression_run_for_key("
        "  %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s"
        ") AS id;",
        (
            key_hash,
            "run-1",
            "emoji test",
            0.6,
            "baseline prompt",
            "candidate prompt",
            3,
            2,
            12.5,
            '[{"input": "What is ML?", "similarity": 0.1, "regressed": true}]',
            datetime.now(timezone.utc).isoformat(),
        ),
    )
    assert cur.fetchone()["id"] is not None

    cur.execute(
        "SELECT user_id, run_id, name, threshold, version_a_prompt, "
        "       inputs_count, regressions_count, duration_sec, results "
        "FROM public.regression_runs WHERE run_id = 'run-1';"
    )
    row = cur.fetchone()
    assert row is not None
    assert row["user_id"] == "reg-user"
    assert row["run_id"] == "run-1"
    assert row["name"] == "emoji test"
    assert row["threshold"] == 0.6
    assert row["version_a_prompt"] == "baseline prompt"
    assert row["inputs_count"] == 3
    assert row["regressions_count"] == 2
    assert row["duration_sec"] == 12.5
    assert row["results"] == [{"input": "What is ML?", "similarity": 0.1, "regressed": True}]


def test_insert_regression_run_for_key_is_idempotent_per_run_id(clean_db):
    """SDK retries (same run_id) must never duplicate a regression run -
    ON CONFLICT DO NOTHING on (user_id, run_id)."""
    cur = clean_db
    key_hash = "f" * 64
    _seed_api_key(cur, key_hash=key_hash, user_id="reg-user-2")

    args = (
        key_hash, "run-retry", None, 0.6, None, None,
        1, 0, 3.0, '[{"input": "x", "similarity": 0.9}]',
        datetime.now(timezone.utc).isoformat(),
    )
    cur.execute(
        "SELECT public.insert_regression_run_for_key("
        "  %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s"
        ") AS id;",
        args,
    )
    first_id = cur.fetchone()["id"]
    assert first_id is not None

    # Retry, same run_id, same payload (the SDK's retry semantics).
    cur.execute(
        "SELECT public.insert_regression_run_for_key("
        "  %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s"
        ") AS id;",
        args,
    )
    assert cur.fetchone()["id"] is None  # no-op, returns NULL

    cur.execute(
        "SELECT count(*) AS n FROM public.regression_runs WHERE run_id = 'run-retry';"
    )
    assert cur.fetchone()["n"] == 1


def test_insert_regression_run_for_key_rejects_unknown_key(clean_db):
    """Unknown / revoked key_hash must fail, no orphan regression rows."""
    cur = clean_db
    try:
        cur.execute(
            "SELECT public.insert_regression_run_for_key("
            "  %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s"
            ") AS id;",
            (
                "z" * 64, "run-unknown", None, 0.6, None, None,
                0, 0, 0.0, '[]', datetime.now(timezone.utc).isoformat(),
            ),
        )
        raised = False
    except Exception:  # noqa: BLE001 -- test wants "any exception" for an invalid key, not a specific type
        raised = True
    assert raised, "expected invalid_api_key exception for unknown key"
    cur.execute(
        "SELECT count(*) AS n FROM public.regression_runs WHERE run_id = 'run-unknown';"
    )
    assert cur.fetchone()["n"] == 0
