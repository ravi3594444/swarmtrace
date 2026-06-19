import type { Trace } from "./traces-data";
import { DEMO_TRACES } from "./traces-data";

const API_BASE =
  (import.meta.env.VITE_API_URL as string | undefined) ?? "http://localhost:8000";

type ApiSpan = {
  id: string;
  parent_id: string | null;
  function: string;
  args: string;
  output: string;
  duration: number;        // ms from backend
  status: "SUCCESS" | "ERROR";
  error: string | null;
  timestamp: string;
  tokens_in: number;
  tokens_out: number;
  cost: number;
};

function toTrace(s: ApiSpan): Trace {
  return {
    id: s.id,
    parent_id: s.parent_id ?? null,
    function: s.function ?? "(unknown)",
    args: s.args ?? "",
    output: s.output ?? "{}",
    latency_sec: (s.duration ?? 0) / 1000,
    error: s.error ?? null,
    timestamp: s.timestamp ?? new Date().toISOString(),
    input_tokens: s.tokens_in ?? 0,
    output_tokens: s.tokens_out ?? 0,
    cost_usd: s.cost ?? 0,
  };
}

export type FetchResult = { traces: Trace[]; source: "api" | "demo" };

export async function fetchTraces(): Promise<FetchResult> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(`${API_BASE}/traces`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { traces: ApiSpan[] };
    const traces = (data.traces ?? []).map(toTrace);
    return { traces: traces.length ? traces : DEMO_TRACES, source: traces.length ? "api" : "demo" };
  } catch {
    return { traces: DEMO_TRACES, source: "demo" };
  }
}
