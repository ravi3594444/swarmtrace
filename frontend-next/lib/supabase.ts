// SECURITY NOTE: This helper uses the Supabase SERVICE KEY, which bypasses Row Level
// Security entirely. That means Clerk's userId is trusted at the application layer only.
// Before going multi-tenant, enable RLS on all tables and add policies like:
//   CREATE POLICY "Users can only see their own rows"
//   ON api_keys FOR ALL USING (user_id = auth.uid());
// Then switch to a per-user JWT (from Clerk's Supabase integration) instead of the
// service key, so the DB enforces tenant isolation independent of this code.
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

export async function supaRequest(path: string, options: RequestInit = {}) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error("Supabase environment variables are missing on this server instance.");
  }

  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const headers = {
    "apikey": SUPABASE_SERVICE_KEY,
    "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
    "Content-Type": "application/json",
    ...options.headers,
  };

  const response = await fetch(url, {
    ...options,
    headers,
  });

  if (!response.ok) {
    const text = await response.clone().text().catch(() => "");
    throw new Error(`Supabase REST Error: ${response.status} - ${text || response.statusText}`);
  }

  const text = await response.text();
  return text ? JSON.parse(text) : null;
}
