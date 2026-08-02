'use client'

import { Fragment, useMemo, useState } from "react";
import type { Trace } from "@/lib/trace-types";
import { formatTraceTime as formatTime } from "@/lib/format-time";
import { ArrowUpDown, ArrowUp, ArrowDown, ChevronLeft, ChevronRight, Copy, Check } from "lucide-react";

// Includes 500 so users can see the full backend cap (500 traces) on one
// page instead of paginating 20 times. 25/50/100 remain for smaller screens
// or when the user prefers incremental browsing.
const PAGE_SIZES = [25, 50, 100, 500];

type SortKey = "id" | "function" | "latency_sec" | "input_tokens" | "output_tokens" | "cost_usd" | "timestamp";

function SortIcon({ active, asc }: { active: boolean; asc: boolean }) {
  if (!active) return <ArrowUpDown className="w-3 h-3 opacity-25" />;
  return asc ? <ArrowUp className="w-3 h-3 text-foreground" /> : <ArrowDown className="w-3 h-3 text-foreground" />;
}

function truncateId(id: string): string {
  return id.length <= 10 ? id : `${id.slice(0, 4)}…${id.slice(-4)}`;
}

/** Copy-on-hover ID cell. The full UUID is shown in a title tooltip; the
 *  visible text is truncated to 8 chars (matching CallTree/SpanRow). A
 *  copy button appears on hover so the full ID can be grabbed without a
 *  trip to the detail drawer. */
function IdCell({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <td className="px-4 py-3 text-[11px] text-muted-foreground">
      <div className="flex items-center gap-1 group">
        <span className="font-mono" title={id}>{truncateId(id)}</span>
        <button
          onClick={async (e) => {
            e.stopPropagation();
            try {
              await navigator.clipboard.writeText(id);
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            } catch {
              // clipboard may be blocked — non-fatal, the title attr has the full id
            }
          }}
          title={copied ? "Copied!" : `Copy ${id}`}
          aria-label={copied ? "Copied" : `Copy trace ID ${id}`}
          className="opacity-0 group-hover:opacity-100 flex items-center justify-center w-5 h-5 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-all"
        >
          {copied ? <Check className="w-3 h-3 text-emerald-600 dark:text-emerald-400" /> : <Copy className="w-3 h-3" />}
        </button>
      </div>
    </td>
  );
}

function SortableHeader({ k, sortKey, asc, onToggle, children }: {
  k: SortKey;
  sortKey: SortKey;
  asc: boolean;
  onToggle: (k: SortKey) => void;
  children: React.ReactNode;
}) {
  const active = sortKey === k;
  // The <th> keeps its implicit columnheader role (so aria-sort is valid)
  // and carries the sort state. The actual interactive element is a nested
  // <button> — this is the WAI-ARIA recommended pattern for sortable
  // column headers, and it's keyboard-accessible by default (no need for
  // tabIndex/role hacks on the <th> itself).
  return (
    <th
      aria-sort={active ? (asc ? "ascending" : "descending") : "none"}
      className="px-4 py-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground text-left"
    >
      <button
        onClick={() => onToggle(k)}
        aria-label={`Sort by ${children}${active ? ` (${asc ? "ascending" : "descending"})` : ""}`}
        className="flex items-center gap-1 cursor-pointer select-none hover:text-foreground transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2"
      >
        {children}<SortIcon active={active} asc={asc} />
      </button>
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
  const [page, setPage]       = useState(0);
  const [pageSize, setPageSize] = useState(25);

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

  // Clamp instead of resetting in an effect: if filters shrink the data set
  // below the current page, fall back to the last valid page.
  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const start = safePage * pageSize;
  const pageRows = sorted.slice(start, start + pageSize);

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
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
            {pageRows.map((t) => {
              const ok = !t.error;
              return (
                <Fragment key={t.id}>
                  <tr
                    onClick={() => onSelect(t)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onSelect(t);
                      }
                    }}
                    role="button"
                    tabIndex={0}
                    aria-pressed={selected?.id === t.id}
                    className={`cursor-pointer transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2 ${
                      selected?.id === t.id ? "bg-muted/60 border-l-2 border-l-primary" : "hover:bg-muted/30"
                    } ${newIds?.has(t.id) ? "swarm-row-new" : ""}`}
                  >
                    <IdCell id={t.id} />
                    <td className="px-4 py-3 text-xs font-medium text-foreground">{t.function}</td>
                    <td className="px-4 py-3 text-xs tabular-nums text-foreground">{t.latency_sec.toFixed(2)}s</td>
                    <td className="px-4 py-3 text-xs tabular-nums text-foreground">{t.input_tokens}</td>
                    <td className="px-4 py-3 text-xs tabular-nums text-foreground">{t.output_tokens || <span className="text-muted-foreground/50">0</span>}</td>
                    <td className="px-4 py-3 text-xs tabular-nums text-foreground font-semibold">${t.cost_usd.toFixed(4)}</td>
                    <td className="px-4 py-3 text-center">
                      <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-bold uppercase border ${
                        ok ? "bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-900/60" : "bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-400 border-red-200 dark:border-red-900/60"
                      }`}>{ok ? "OK" : "FAIL"}</span>
                    </td>
                    <td className="px-4 py-3 text-[11px] text-muted-foreground">{formatTime(t.timestamp)}</td>
                  </tr>
                  {showErrors && t.error && (
                    <tr className="bg-red-50/50 dark:bg-red-950/20">
                      <td colSpan={8} className="px-4 pb-3 pt-0">
                        <div className="rounded-lg border-l-2 border-red-400 bg-red-50 dark:bg-red-950/30 px-3 py-2 text-xs text-red-700 dark:text-red-400">{t.error}</div>
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
      {sorted.length > 0 && (
        <div className="flex items-center justify-between border-t border-border bg-muted/20 px-4 py-2.5">
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <span>Rows per page</span>
            <select
              value={pageSize}
              onChange={(e) => { setPageSize(Number(e.target.value)); setPage(0); }}
              className="h-9 rounded-md border border-border bg-card px-2 text-[11px] text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              aria-label="Rows per page"
            >
              {PAGE_SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-[11px] text-muted-foreground tabular-nums">
              {start + 1}–{Math.min(start + pageSize, sorted.length)} of {sorted.length}
            </span>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setPage(Math.max(safePage - 1, 0))}
                disabled={safePage === 0}
                aria-label="Previous page"
                className="flex items-center justify-center w-9 h-9 rounded-md border border-border bg-card text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <span className="text-[11px] text-muted-foreground tabular-nums px-1">
                {safePage + 1} / {pageCount}
              </span>
              <button
                onClick={() => setPage(Math.min(safePage + 1, pageCount - 1))}
                disabled={safePage >= pageCount - 1}
                aria-label="Next page"
                className="flex items-center justify-center w-9 h-9 rounded-md border border-border bg-card text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}