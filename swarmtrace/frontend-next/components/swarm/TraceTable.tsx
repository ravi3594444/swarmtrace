'use client'

import { Fragment, useMemo, useState } from "react";
import type { Trace } from "@/lib/trace-types";
import { ArrowUpDown, ArrowUp, ArrowDown } from "lucide-react";

type SortKey = "id" | "function" | "latency_sec" | "input_tokens" | "output_tokens" | "cost_usd" | "timestamp";

function formatTime(iso: string) {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

function SortIcon({ active, asc }: { active: boolean; asc: boolean }) {
  if (!active) return <ArrowUpDown className="w-3 h-3 opacity-25" />;
  return asc ? <ArrowUp className="w-3 h-3 text-foreground" /> : <ArrowDown className="w-3 h-3 text-foreground" />;
}

function SortableHeader({ k, sortKey, asc, onToggle, children }: {
  k: SortKey;
  sortKey: SortKey;
  asc: boolean;
  onToggle: (k: SortKey) => void;
  children: React.ReactNode;
}) {
  return (
    <th onClick={() => onToggle(k)} className="px-4 py-3 cursor-pointer select-none text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors text-left">
      <span className="flex items-center gap-1">{children}<SortIcon active={sortKey === k} asc={asc} /></span>
    </th>
  );
}

export function TraceTable({ traces, onSelect, showErrors = false, newIds, selected }: {
  traces: Trace[];
  onSelect: (t: Trace) => void;
  showErrors?: boolean;
  newIds?: Map<string, number>;
  selected?: Trace | null;
}) {
  const [sortKey, setSortKey] = useState<SortKey>("timestamp");
  const [asc, setAsc]         = useState(true);

  const sorted = useMemo(() => {
    const arr = [...traces];
    arr.sort((a, b) => {
      const av = a[sortKey] as number | string;
      const bv = b[sortKey] as number | string;
      return (av > bv ? 1 : -1) * (asc ? 1 : -1);
    });
    return arr;
  }, [traces, sortKey, asc]);

  const toggle = (k: SortKey) => { if (k === sortKey) setAsc(!asc); else { setSortKey(k); setAsc(true); } };

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden shadow-sm">
      <div className="flex items-center justify-between border-b border-border bg-muted/30 px-4 py-3">
        <h3 className="text-sm font-semibold text-foreground">{showErrors ? "Failed Traces" : "All Traces"}</h3>
        <span className="text-[11px] text-muted-foreground">{sorted.length} rows</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="border-b border-border bg-muted/20">
            <tr>
              <SortableHeader k="id" sortKey={sortKey} asc={asc} onToggle={toggle}>ID</SortableHeader>
              <SortableHeader k="function" sortKey={sortKey} asc={asc} onToggle={toggle}>Function</SortableHeader>
              <SortableHeader k="latency_sec" sortKey={sortKey} asc={asc} onToggle={toggle}>Latency</SortableHeader>
              <SortableHeader k="input_tokens" sortKey={sortKey} asc={asc} onToggle={toggle}>In</SortableHeader>
              <SortableHeader k="output_tokens" sortKey={sortKey} asc={asc} onToggle={toggle}>Out</SortableHeader>
              <SortableHeader k="cost_usd" sortKey={sortKey} asc={asc} onToggle={toggle}>Cost</SortableHeader>
              <th className="px-4 py-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground text-center">Status</th>
              <SortableHeader k="timestamp" sortKey={sortKey} asc={asc} onToggle={toggle}>Time</SortableHeader>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {sorted.map((t) => {
              const ok = !t.error;
              return (
                <Fragment key={t.id}>
                  <tr
                    onClick={() => onSelect(t)}
                    className={`cursor-pointer transition-colors ${
                      selected?.id === t.id ? "bg-muted/60 border-l-2 border-l-primary" : "hover:bg-muted/30"
                    } ${newIds?.has(t.id) ? "swarm-row-new" : ""}`}
                  >
                    <td className="px-4 py-3 text-[11px] text-muted-foreground">{t.id}</td>
                    <td className="px-4 py-3 text-xs font-medium text-foreground">{t.function}</td>
                    <td className="px-4 py-3 text-xs tabular-nums text-foreground">{t.latency_sec.toFixed(2)}s</td>
                    <td className="px-4 py-3 text-xs tabular-nums text-foreground">{t.input_tokens}</td>
                    <td className="px-4 py-3 text-xs tabular-nums text-foreground">{t.output_tokens || <span className="text-muted-foreground/50">0</span>}</td>
                    <td className="px-4 py-3 text-xs tabular-nums text-foreground font-semibold">${t.cost_usd.toFixed(4)}</td>
                    <td className="px-4 py-3 text-center">
                      <span className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-bold uppercase border ${
                        ok ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-red-50 text-red-700 border-red-200"
                      }`}>{ok ? "OK" : "FAIL"}</span>
                    </td>
                    <td className="px-4 py-3 text-[11px] text-muted-foreground">{formatTime(t.timestamp)}</td>
                  </tr>
                  {showErrors && t.error && (
                    <tr className="bg-red-50/50">
                      <td colSpan={8} className="px-4 pb-3 pt-0">
                        <div className="rounded-lg border-l-2 border-red-400 bg-red-50 px-3 py-2 text-xs text-red-700">{t.error}</div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {sorted.length === 0 && (
              <tr><td colSpan={8} className="px-4 py-12 text-center text-sm text-muted-foreground">No traces to display</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}