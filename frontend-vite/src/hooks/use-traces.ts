import { useState, useEffect, useCallback, useRef } from "react";
import type { Trace } from "@/lib/traces-data";
import { fetchTraces } from "@/lib/api";

export function useTraces(pollMs = 8000) {
  const [traces, setTraces] = useState<Trace[]>([]);
  const [loading, setLoading] = useState(true);
  const [source, setSource] = useState<"api" | "demo" | null>(null);
  const [isLive, setIsLive] = useState(true);
  const interval = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    const r = await fetchTraces();
    setTraces(r.traces);
    setSource(r.source);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (interval.current) clearInterval(interval.current);
    if (isLive) interval.current = setInterval(load, pollMs);
    return () => { if (interval.current) clearInterval(interval.current); };
  }, [isLive, load, pollMs]);

  return { traces, loading, source, isLive, toggleLive: () => setIsLive(v => !v) };
}
