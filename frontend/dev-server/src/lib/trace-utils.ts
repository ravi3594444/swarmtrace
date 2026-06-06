import type { Trace } from "@/lib/traces-data";

export function buildCallChain(trace: Trace, all: Trace[]): Trace[] {
  const byId = new Map(all.map((t) => [t.id, t]));
  const chain: Trace[] = [];
  let cur: Trace | undefined = trace;
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    chain.unshift(cur);
    seen.add(cur.id);
    cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
  }
  return chain;
}

export function getSiblings(trace: Trace, all: Trace[]): Trace[] {
  if (!trace.parent_id) return all.filter((t) => !t.parent_id && t.id !== trace.id);
  return all.filter((t) => t.parent_id === trace.parent_id && t.id !== trace.id);
}
