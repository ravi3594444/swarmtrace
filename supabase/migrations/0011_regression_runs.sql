-- 0011_regression_runs.sql
-- Prompt-regression runs reported by swarmtrace.regression.compare().
--
--   SDK: POST /api/regression (X-API-Key) -> insert_regression_run_for_key
--   UI:  GET /api/regression (Clerk JWT) -> RLS select on regression_runs
--
-- The write path follows 0010: insert_regression_run_for_key is SECURITY DEFINER
-- and resolves key_hash to user_id inside Postgres.
-- (user_id, run_id) is unique; ON CONFLICT DO NOTHING makes retried POSTs no-ops.

CREATE TABLE IF NOT EXISTS public.regression_runs (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           TEXT NOT NULL,
    run_id            TEXT NOT NULL,          -- client-generated idempotency key
    name              TEXT,
    threshold         DOUBLE PRECISION NOT NULL DEFAULT 0.6,
    version_a_prompt  TEXT,
    version_b_prompt  TEXT,
    inputs_count      INTEGER NOT NULL DEFAULT 0,
    regressions_count INTEGER NOT NULL DEFAULT 0,
    duration_sec      DOUBLE PRECISION NOT NULL DEFAULT 0,
    results           JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT regression_runs_user_run_unique UNIQUE (user_id, run_id)
);

CREATE INDEX IF NOT EXISTS regression_runs_user_created_idx
    ON public.regression_runs (user_id, created_at DESC);

-- RLS: dashboard reads only ever see the caller's own runs
ALTER TABLE public.regression_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "regression_runs_select_own" ON public.regression_runs;
CREATE POLICY "regression_runs_select_own" ON public.regression_runs
    FOR SELECT
    USING (user_id = auth.jwt() ->> 'sub');

-- No INSERT policy for the JWT role: writes go through the API-key RPC below,
-- which stamps the tenant itself.

-- Write path: key-hash-scoped insert
CREATE OR REPLACE FUNCTION public.insert_regression_run_for_key(
    p_key_hash          TEXT,
    p_run_id            TEXT,
    p_name              TEXT DEFAULT NULL,
    p_threshold         DOUBLE PRECISION DEFAULT 0.6,
    p_version_a_prompt  TEXT DEFAULT NULL,
    p_version_b_prompt  TEXT DEFAULT NULL,
    p_inputs_count      INTEGER DEFAULT 0,
    p_regressions_count INTEGER DEFAULT 0,
    p_duration_sec      DOUBLE PRECISION DEFAULT 0,
    p_results           JSONB DEFAULT '[]'::jsonb,
    p_created_at        TIMESTAMPTZ DEFAULT now()
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id TEXT;
    v_id      UUID;
BEGIN
    v_user_id := public.resolve_api_key_user_id(p_key_hash);

    INSERT INTO public.regression_runs (
        user_id, run_id, name, threshold,
        version_a_prompt, version_b_prompt,
        inputs_count, regressions_count, duration_sec,
        results, created_at
    ) VALUES (
        v_user_id, p_run_id, p_name,
        COALESCE(p_threshold, 0.6),
        p_version_a_prompt, p_version_b_prompt,
        COALESCE(p_inputs_count, 0), COALESCE(p_regressions_count, 0),
        COALESCE(p_duration_sec, 0),
        COALESCE(p_results, '[]'::jsonb),
        COALESCE(p_created_at, now())
    )
    ON CONFLICT (user_id, run_id) DO NOTHING
    RETURNING id INTO v_id;

    UPDATE public.api_keys
       SET last_used = now()
     WHERE key_hash = p_key_hash
       AND revoked = false;

    RETURN v_id;  -- NULL when the run_id was already reported (retry)
END;
$$;

-- Revoke anon/authenticated explicitly: Supabase default privileges grant them
-- a direct EXECUTE on new functions, which a PUBLIC revoke does not remove.
REVOKE ALL ON FUNCTION public.insert_regression_run_for_key(
    TEXT, TEXT, TEXT, DOUBLE PRECISION, TEXT, TEXT,
    INTEGER, INTEGER, DOUBLE PRECISION, JSONB, TIMESTAMPTZ
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.insert_regression_run_for_key(
    TEXT, TEXT, TEXT, DOUBLE PRECISION, TEXT, TEXT,
    INTEGER, INTEGER, DOUBLE PRECISION, JSONB, TIMESTAMPTZ
) TO service_role;
