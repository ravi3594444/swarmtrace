import { Fragment, useMemo, useState } from "react";
import type { Trace } from "@/lib/traces-data";

type SortKey =
  | "id"
  | "function"
  | "latency_sec"
  | "input_tokens"
  | "output_tokens"
  | "cost_usd"
  | "timestamp";

function formatTime(iso: string) {
  // Locale-independent HH:MM:SS so SSR === client
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

export function TraceTable({
  traces,
  onSelect,
  showErrors = false,
  newIds,
}: {
  traces: Trace[];
  onSelect: (t: Trace) => void;
  showErrors?: boolean;
  newIds?: Map<string, number>;
}) {
  const [sortKey, setSortKey] = useState<SortKey>("timestamp");
  const [asc, setAsc] = useState(true);

  const sorted = useMemo(() => {
    const arr = [...traces];
    arr.sort((a, b) => {
      const av = a[sortKey] as number | string;
      const bv = b[sortKey] as number | string;
      if (av === bv) return 0;
      return (av > bv ? 1 : -1) * (asc ? 1 : -1);
    });
    return arr;
  }, [traces, sortKey, asc]);

  const toggle = (k: SortKey) => {
    if (k === sortKey) setAsc(!asc);
    else {
      setSortKey(k);
      setAsc(true);
    }
  };

  const H = ({ k, children, className = "" }: { k: SortKey; children: React.ReactNode; className?: string }) => (
    <th
      onClick={() => toggle(k)}
      className={`cursor-pointer select-none px-4 py-3 text-left font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground hover:text-foreground ${className}`}
    >
      {children}
      {sortKey === k && <span className="ml-1">{asc ? "↑" : "↓"}</span>}
    </th>
  );

  return (
    <div className="overflow-hidden border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border bg-muted/30 px-4 py-2.5 font-mono text-[11px] uppercase tracking-[0.16em] font-bold text-muted-foreground">
        <span>{showErrors ? "Failed Traces" : "All Traces"}</span>
        <span className="text-[10px] text-muted-foreground/60">{sorted.length} ROWS</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full font-mono text-[11px]">
          <thead className="border-b border-border bg-muted/20">
            <tr>
              <H k="id">ID</H>
              <H k="function">Function</H>
              <H k="latency_sec" className="text-right">Latency</H>
              <H k="input_tokens" className="text-right">Tokens In</H>
              <H k="output_tokens" className="text-right">Tokens Out</H>
              <H k="cost_usd" className="text-right">Cost</H>
              <th className="px-4 py-3 text-center font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">Status</th>
              <H k="timestamp">Timestamp</H>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60 text-muted-foreground">
            {sorted.map((t) => {
              const ok = !t.error;
              const isNew = newIds?.has(t.id);
              return (
                <Fragment key={t.id}>
                  <tr
                    onClick={() => onSelect(t)}
                    className={`cursor-pointer transition-colors hover:bg-muted/30${
                      isNew ? " swarm-row-new" : ""
                    }`}
                  >
                    <td className="px-4 py-2.5 text-muted-foreground/60">{t.id}</td>
                    <td className="px-4 py-2.5 text-foreground">{t.function}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{t.latency_sec.toFixed(2)}s</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{t.input_tokens}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{t.output_tokens || <span className="text-muted-foreground/40">0</span>}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-primary">${t.cost_usd.toFixed(4)}</td>
                    <td className="px-4 py-2.5 text-center">
                      <span
                        className={`text-[10px] font-bold uppercase ${
                          ok ? "text-[oklch(0.7_0.18_145)]" : "text-destructive"
                        }`}
                      >
                        {ok ? "OK" : "FAIL"}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground/70">
                      {formatTime(t.timestamp)}
                    </td>
                  </tr>
                  {showErrors && t.error && (
                    <tr className="border-b border-border/60 bg-destructive/5">
                      <td colSpan={8} className="px-3 py-2">
                        <div className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 font-mono text-xs text-destructive">
                          {t.error}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {sorted.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-sm text-muted-foreground">
                  No traces.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
