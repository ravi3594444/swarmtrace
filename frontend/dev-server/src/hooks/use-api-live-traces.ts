import { useEffect, useState } from "react";
import { DEMO_TRACES, type Trace } from "@/lib/traces-data";

const POLL_MS = 2000;
const NEW_WINDOW_MS = 5000;

function mapApiTrace(t: any): Trace {
  return {
    id: t.id,
    parent_id: t.parent_id ?? null,
    function: t.function ?? "(unknown)",
    args: t.args ?? "",
    output: t.output ?? "{}",
    latency_sec:
      typeof t.duration === "number"
        ? t.duration / 1000
        : (t.latency_sec ?? 0),
    error: t.error ?? null,
    timestamp: t.timestamp ?? new Date().toISOString(),
    input_tokens: t.tokens_in ?? t.input_tokens ?? 0,
    output_tokens: t.tokens_out ?? t.output_tokens ?? 0,
    cost_usd: t.cost ?? t.cost_usd ?? 0,
  };
}

export function useApiLiveTraces(enabled: boolean) {
  const [traces, setTraces] = useState<Trace[]>(DEMO_TRACES);
  const [newIds, setNewIds] = useState<Map<string, number>>(new Map());
  const [lastPoll, setLastPoll] = useState<number | null>(null);
  const [error, setError] = useState<boolean>(false);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const poll = async () => {
      try {
        const res = await fetch(
          `${import.meta.env.VITE_API_BASE_URL || "http://localhost:8000"}/traces`,
          { cache: "no-store" }
        );
        if (!res.ok) throw new Error(String(res.status));

        const json = await res.json();
        const raw: any[] = json.traces ?? json;
        const mapped: Trace[] = raw.map(mapApiTrace);

        if (cancelled) return;
        setTraces(mapped.length > 0 ? mapped : DEMO_TRACES);
        setError(false);

        if (mapped.length > 0) {
          setNewIds((m) => {
            const next = new Map(m);
            const now = Date.now();
            mapped.forEach((t) => next.set(t.id, now));
            return next;
          });
        }

        setLastPoll(Date.now());
      } catch {
        if (cancelled) return;
        setTraces(DEMO_TRACES);
        setError(true);
        setLastPoll(Date.now());
      }
    };

    poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [enabled]);

  // Sweep expired "new" markers
  useEffect(() => {
    if (newIds.size === 0) return;
    const id = setInterval(() => {
      setNewIds((m) => {
        const now = Date.now();
        const next = new Map(m);
        let changed = false;
        next.forEach((ts, key) => {
          if (now - ts > NEW_WINDOW_MS) {
            next.delete(key);
            changed = true;
          }
        });
        return changed ? next : m;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [newIds.size]);

  return { traces, newIds, lastPoll, error };
}
