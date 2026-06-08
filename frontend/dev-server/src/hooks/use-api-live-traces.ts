import { useEffect, useState } from "react";
import { DEMO_TRACES, type Trace } from "@/lib/traces-data";

// Type for the environment variables
declare global {
  interface ImportMeta {
    env: {
      VITE_API_BASE_URL: string;
      // Add other environment variables here if needed
    };
  }
}

const POLL_MS = 2000; 
const NEW_WINDOW_MS = 5000;

/**
 * Custom hook for fetching live traces from the backend API
 * This is a client-side alternative to the server-side trace functions
 */
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
        // Fetch directly from the API endpoint
        const res = await fetch(`${import.meta.env.VITE_API_BASE_URL || "http://localhost:8000"}/traces`, {
          cache: "no-store"
        });

        if (!res.ok) throw new Error(String(res.status));

        const json = await res.json()
        const apiTraces = (json.traces ?? json) as Trace[];

        if (cancelled) return;

        // Update traces with data from API
        setTraces(apiTraces);
        setError(false);

        // Mark all new traces as "new"
        if (apiTraces.length > 0) {
          setNewIds((m: Map<string, number>) => {
            const next = new Map(m);
            const now = Date.now();
            apiTraces.forEach((t) => next.set(t.id, now));
            return next;
          });
        }

        setLastPoll(Date.now());
      } catch (err) {
        console.error("Error fetching traces from API:", err);
        // Fall back to demo data if there's an error
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
      setNewIds((m: Map<string, number>) => {
        const now = Date.now();
        const next = new Map(m);
        let changed = false;
        next.forEach((ts: number, key: string) => {
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