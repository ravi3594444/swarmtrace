#!/usr/bin/env python3
"""End-to-end validation of the Supabase migrations + npm db:migrate runner
against a pristine, locally-hosted Postgres (via the `pgserver` pip package,
which bundles the Postgres binaries — no Docker, no system Postgres needed).

What it proves (the exact things that were broken in the "valid API key,
zero traces on dashboard" production incident):

  1. all 13 files in supabase/migrations apply cleanly, in order, via
     scripts/run-migrations.mjs (npm run db:migrate), each in one transaction
     with a schema_migrations ledger entry;
  2. re-running the runner is a strict no-op (idempotent);
  3. --status reports "up to date";
  4. re-applying every file RAW (the Supabase SQL-editor path) succeeds, so
     the files are safe to paste into a partially-migrated project
     (DROP POLICY IF EXISTS / publication DO-guards / IF NOT EXISTS);
  5. the *_for_key RPCs reject an unknown key hash with invalid_api_key —
     the signal GET /api/health/db uses to verify function signatures
     without a real API key and without writing any rows;
  6. upsert_trace_for_key, called BY NAME with the exact 18-parameter list
     the /api/ingest route sends (mirroring PostgREST's named matching),
     stamps user_id from the key, persists trace_id/kind/session_id/
     attributes, increments daily_metrics, touches api_keys.last_used, and
     is idempotent under the SDK's retry-the-whole-batch semantics.

Usage:
    pip install "pgserver" "psycopg[binary]"
    python3 frontend-next/scripts/e2e_migrations.py

Exits 0 on success, non-zero on the first failed check. Safe to run
anywhere — uses a temp dir for the cluster, never touches real data.
"""

from __future__ import annotations

import hashlib
import os
import subprocess
import sys
import tempfile

try:
    import pgserver
except ImportError:
    sys.exit("pgserver not installed — run: pip install pgserver")
try:
    import psycopg
except ImportError:
    sys.exit("psycopg not installed — run: pip install 'psycopg[binary]'")

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
FRONTEND_DIR = os.path.join(REPO_ROOT, "frontend-next")
MIGRATIONS_DIR = os.path.join(REPO_ROOT, "supabase", "migrations")
PSQL_BIN = os.path.join(os.path.dirname(pgserver.__file__), "pginstall", "bin")

# Supabase-platform shims: things Supabase provides that vanilla PG lacks.
# 0004's policy references auth.uid(); *_jwt() helpers are used by every
# RLS policy; supabase_realtime is the default publication; service_role /
# authenticated are Supabase's predefined roles.
SUPABASE_SHIMS = """
create schema if not exists auth;
create or replace function auth.jwt() returns jsonb
  language sql stable as $$ select '{}'::jsonb $$;
create or replace function auth.uid() returns uuid
  language sql stable as $$ select null::uuid $$;
create role service_role nologin;
create role authenticated nologin;
create role anon nologin;
create publication supabase_realtime;
-- Supabase projects commonly carry default privileges that hand anon /
-- authenticated a DIRECT execute grant on every newly created function.
-- REVOKE ... FROM PUBLIC does not strip direct grants (this is what made
-- 0011's insert_regression_run_for_key callable by anon in production), so
-- simulate the condition to keep the 0010/0011 explicit revokes load-bearing.
alter default privileges for role postgres in schema public
  grant execute on functions to anon, authenticated, service_role;
"""


def main() -> None:
    workdir = tempfile.mkdtemp(prefix="swarmtrace-e2e-pg-")
    srv = pgserver.get_server(workdir)
    uri = "postgresql://postgres@/postgres?host=" + workdir
    env = dict(os.environ, PATH=PSQL_BIN + ":" + os.environ["PATH"], SUPABASE_DB_URL=uri)
    psql = os.path.join(PSQL_BIN, "psql")

    def psql_cli(*args: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            [psql, uri, *args], capture_output=True, text=True, check=False
        )

    def runner(*args: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            ["node", "scripts/run-migrations.mjs", *args],
            cwd=FRONTEND_DIR, env=env, capture_output=True, text=True, check=False,
        )

    srv.psql(SUPABASE_SHIMS)
    print("✓ supabase platform shims installed")

    # ── 1. migrate the pristine DB via the runner ────────────────────────────
    r = runner()
    assert r.returncode == 0, f"first migration run failed:\n{r.stdout}{r.stderr}"
    n_files = len([f for f in os.listdir(MIGRATIONS_DIR) if f.endswith(".sql")])
    assert r.stdout.count("… ok") == n_files, r.stdout
    print(f"✓ npm db:migrate applied {n_files} migration files in order")

    # ── 2. idempotent re-run + 3. status ─────────────────────────────────────
    r = runner()
    assert r.returncode == 0 and "already applied" in r.stdout, r.stdout
    r = runner("--status")
    assert r.returncode == 0 and "up to date" in r.stdout, r.stdout
    print("✓ runner re-run is a no-op; --status reports up to date")

    # ── 4. raw re-apply of every file (the SQL-editor paste path) ────────────
    for f in sorted(os.listdir(MIGRATIONS_DIR)):
        if not f.endswith(".sql"):
            continue
        r = psql_cli("-X", "-v", "ON_ERROR_STOP=1", "--single-transaction",
                     "-f", os.path.join(MIGRATIONS_DIR, f))
        assert r.returncode == 0, f"raw re-apply of {f} failed:\n{r.stderr}"
    print("✓ every migration file re-applies raw with zero errors (paste-safe)")

    # ── 4b. grant hardening: only service_role may execute the *_for_key RPCs ─
    # Supabase projects can carry ALTER DEFAULT PRIVILEGES that hand anon /
    # authenticated a DIRECT execute grant on newly created functions, which
    # REVOKE ... FROM PUBLIC does not strip. Migrations 0010/0011 must revoke
    # those roles explicitly so the API-key RPCs stay service_role-only.
    r = psql_cli(
        "-AtX", "-c",
        "with fns as ("
        "  select p.oid, p.proname, p.proacl from pg_proc p"
        "  join pg_namespace n on n.oid = p.pronamespace"
        "  where n.nspname = 'public'"
        "    and (p.proname like '%\\_for\\_key' or p.proname = 'resolve_api_key_user_id')"
        ") "
        "select proname || ': no explicit acl (PUBLIC keeps default EXECUTE)'"
        " from fns where proacl is null "
        "union all "
        "select proname || ': EXECUTE granted to '"
        "       || case a.grantee when 0 then 'PUBLIC' else a.grantee::regrole::text end "
        "from fns, aclexplode(fns.proacl) a "
        "where a.privilege_type = 'EXECUTE'"
        "  and (a.grantee = 0 or a.grantee::regrole::text in ('anon', 'authenticated'))"
    )
    assert r.returncode == 0, r.stderr
    assert not r.stdout.strip(), f"RPCs executable by non-service roles:\n{r.stdout}"

    # Positive half: service_role must KEEP execute on every *_for_key RPC
    # (guards against a future over-revoke), and all four must exist.
    r = psql_cli(
        "-AtX", "-c",
        "select count(*), "
        "count(*) filter (where has_function_privilege('service_role', p.oid, 'EXECUTE')) "
        "from pg_proc p join pg_namespace n on n.oid = p.pronamespace "
        "where n.nspname = 'public' "
        "  and (p.proname like '%\\_for\\_key' or p.proname = 'resolve_api_key_user_id')"
    )
    assert r.returncode == 0, r.stderr
    total, with_service = (int(x) for x in r.stdout.strip().split("|"))
    assert total >= 4, f"expected at least the 4 key-scoped RPCs, found {total}"
    assert total == with_service, (
        f"{total - with_service} of {total} key-scoped RPCs lost service_role EXECUTE"
    )
    print("✓ *_for_key RPCs are not executable by PUBLIC/anon/authenticated,"
          " and service_role keeps EXECUTE")

    # ── 5. fake-key RPC probe semantics (what /api/health/db relies on) ──────
    bad = "f" * 64
    r = psql_cli("-AtX", "-c", f"select public.upsert_trace_for_key(p_key_hash := '{bad}', p_id := 'x1')")
    assert "invalid_api_key" in r.stderr, r.stderr
    print("✓ unknown key hash raises invalid_api_key before writing anything")

    # ── 6. full ingest-path insert exactly as /api/ingest performs it ────────
    key = "st_" + "ab" * 24
    key_hash = hashlib.sha256(key.encode()).hexdigest()
    srv.psql(
        "insert into public.api_keys(id, key_hash, key_prefix, user_id, name) "
        f"values ('k1', '{key_hash}', 'st_ababab', 'user_123', 'test key')"
    )
    conn = psycopg.connect(uri)

    params = {
        "p_key_hash": key_hash, "p_id": "span-1", "p_parent_id": None, "p_trace_id": "run-1",
        "p_function": "my_agent", "p_args": "{}", "p_output": "ok", "p_latency_sec": 1.5,
        "p_error": None, "p_timestamp": "2026-08-04T12:00:00+00:00",
        "p_input_tokens": 10, "p_output_tokens": 20, "p_cost_usd": 0.0007, "p_kind": "agent",
        "p_agent_id": "span-1", "p_agent_name": "my_agent", "p_session_id": "sess-1",
        "p_attributes": '{"framework": "langgraph"}',
    }
    named = ", ".join(f"{k} := %({k})s" for k in params)
    was_insert = conn.execute(f"select public.upsert_trace_for_key({named})", params).fetchone()
    assert was_insert and was_insert[0] is True

    t = conn.execute(
        "select user_id, trace_id, kind, attributes->>'framework', session_id "
        "from public.traces where id = 'span-1'"
    ).fetchone()
    assert t == ("user_123", "run-1", "agent", "langgraph", "sess-1"), t

    m = conn.execute(
        "select cost_usd, input_tokens, output_tokens, trace_count "
        "from public.daily_metrics where user_id = 'user_123'"
    ).fetchone()
    assert abs(m[0] - 0.0007) < 1e-9 and m[1:] == (10, 20, 1), m

    lu = conn.execute("select last_used is not null from public.api_keys where id = 'k1'").fetchone()
    assert lu and lu[0] is True

    # idempotent retry (SDK re-sends the whole batch on failure)
    params["p_attributes"] = None
    conn.execute(f"select public.upsert_trace_for_key({named})", params).fetchone()
    dup = conn.execute(
        "select count(*), (select trace_count from public.daily_metrics where user_id = 'user_123') "
        "from public.traces where user_id = 'user_123'"
    ).fetchone()
    assert dup[0] == 1 and dup[1] == 1, dup
    print("✓ upsert_trace_for_key full ingest-path insert + idempotent retry")

    print("\nALL MIGRATION E2E CHECKS PASSED")


if __name__ == "__main__":
    main()
