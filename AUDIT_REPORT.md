# SwarmTrace Security & Architecture Audit

## 1. Authentication & Tenant Isolation
- **Observation:** Single `SUPABASE_SERVICE_KEY` used for ingest and dashboard.
- **Risk:** High. Multi-tenancy depends on application-layer filtering.
- **Recommendation:** Integrate Clerk with Supabase RLS.

## 2. Rate Limiting
- **Observation:** Fallback to local rate limiting.
- **Risk:** Inconsistent across serverless isolates.
- **Recommendation:** Enable Upstash Redis.

## 3. Data Integrity
- **Observation:** 64KB payload limit and 4000 char truncation.
- **Risk:** Loss of detail for complex agent traces.
- **Recommendation:** Use Supabase Storage for large payloads.

## 4. Cost Tracking
- **Observation:** Dynamic fetching of prices.
- **Risk:** Network dependency.
- **Recommendation:** Add bundled fallback.
