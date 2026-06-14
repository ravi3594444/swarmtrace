# SwarmTrace Security & Architecture Audit

## 1. Authentication & Tenant Isolation
- **Observation:** The Next.js API uses a single `SUPABASE_SERVICE_KEY`. Isolation is performed in the application layer by filtering queries with `user_id=eq.${userId}`.
- **Risk:** High. If a developer forgets to add the `user_id` filter to a new route, or if there's an injection vulnerability, one user could potentially access another user's traces.
- **Recommendation:** Use Supabase's Clerk integration to leverage Row Level Security (RLS) properly. The `SUPABASE_SERVICE_KEY` should be used sparingly, and standard requests should use the user's own JWT.

## 2. API Key Management
- **Observation:** API keys are hashed with SHA-256 before storage.
- **Risk:** Low. This is a good practice.
- **Observation:** The `ingest` route checks the hash in a database query.
- **Recommendation:** Ensure the `key_hash` column in Supabase has a unique index (it does in the migration, but double-check production).

## 3. Rate Limiting
- **Observation:** The code has a fallback for local rate limiting if Upstash Redis is missing.
- **Risk:** Medium. In a multi-instance serverless environment (like Vercel Edge), local rate limiting is per-isolate. This means a user could potentially bypass the limit by hitting different isolates.
- **Recommendation:** Require Upstash Redis for production to ensure global rate limiting.

## 4. Edge Runtime Limits
- **Observation:** Ingest route uses `runtime = 'edge'`.
- **Risk:** Vercel Edge functions have strict memory and execution time limits.
- **Observation:** Truncation at 4000 characters and payload limit at 64KB are safe for Edge, but might be too restrictive for agents with large reasoning traces.

## 5. Cost Accuracy
- **Observation:** LiteLLM pricing is fetched dynamically.
- **Risk:** If the GitHub URL is unreachable or the format changes, cost tracking breaks.
- **Recommendation:** Bundled fallback pricing table and a validation step for the fetched JSON.

## 6. Concurrency
- **Observation:** Local SQLite uses WAL mode.
- **Risk:** Good for local dev, but not suitable for a distributed production environment.
- **Recommendation:** Ensure the production dashboard is ONLY using Supabase for persistence. The local `api.py` should stay strictly for localhost development.
