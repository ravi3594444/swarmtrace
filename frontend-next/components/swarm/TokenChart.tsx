'use client'

import type { Trace } from "@/lib/trace-types";
import { useState } from "react";

function fmtTick(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k`;
  return String(Math.round(n));
}

const MAX_ROWS = 8;

export function TokenChart({ traces, onSelect }: { traces: Trace[]; onSelect?: (fn: string) => void }) {
  const [hover, setHover] = useState<{ fn: string; input: number; output: number; total: number; x: number; y: number } | null>(null);
  const [showAll, setShowAll] = useState(false);

  const byFn = new Map<string, { function: string; input: number; output: number }>();
  traces.forEach((t) => {
    const cur = byFn.get(t.function) ?? { function: t.function, input: 0, output: 0 };
    cur.input += t.input_tokens;
    cur.output += t.output_tokens;
    byFn.set(t.function, cur);
  });
  const data = Array.from(byFn.values()).sort((a, b) => b.input + b.output - (a.input + a.output));
  // Limit rows so a swarm with 50 functions doesn't render 50 rows. The
  // top N are shown by default; a "show all" toggle reveals the rest.
  const visible = showAll ? data : data.slice(0, MAX_ROWS);
  const hiddenCount = data.length - visible.length;
  const max = Math.max(1, ...data.map((d) => d.input + d.output));
  const ticks = [0, max * 0.25, max * 0.5, max * 0.75, max];

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="flex items-center justify-between border-b border-border bg-muted/40 px-4 py-3">
        <h3 className="text-sm font-semibold text-foreground">Token Burn by Function</h3>
        <div className="flex items-center gap-4 text-[10px] text-muted-foreground font-mono">
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-3 rounded-sm bg-primary" /> INPUT
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-3 rounded-sm bg-primary/25" /> OUTPUT
          </span>
        </div>
      </div>
      <div className="p-4">
        {data.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">No token data</div>
        ) : (
          <>
            {/* Scale ruler — gives every row a fixed reference, so a tiny bar still reads
                against the same axis as the dominant one instead of looking like zero. */}
            <div className="flex pl-32 pr-16 mb-1.5">
              <div className="relative flex-1 h-3.5 text-[10px] font-mono text-muted-foreground/70">
                {ticks.map((t, i) => (
                  <span
                    key={i}
                    className="absolute -translate-x-1/2 first:translate-x-0 last:-translate-x-full"
                    style={{ left: `${(t / max) * 100}%` }}
                  >
                    {fmtTick(t)}
                  </span>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              {visible.map((d) => {
                const total = d.input + d.output;
                const inPct  = (d.input  / max) * 100;
                const outPct = (d.output / max) * 100;
                return (
                  <div
                    key={d.function}
                    className="flex items-center gap-3 group"
                    // Give screen readers a single readable label per row
                    // instead of announcing the raw bar widths. The bars
                    // themselves are decorative (aria-hidden via the span).
                    role="img"
                    aria-label={`${d.function}: ${d.input.toLocaleString()} input, ${d.output.toLocaleString()} output, ${total.toLocaleString()} total tokens`}
                    // Hover tooltip shows exact input/output/total — previously
                    // you had to mentally split the bar widths. Click (when
                    // onSelect is provided) filters the traces page to this
                    // function so you can investigate a token hog.
                    onMouseEnter={(e) => setHover({ fn: d.function, input: d.input, output: d.output, total, x: e.clientX, y: e.clientY })}
                    onMouseLeave={() => setHover(null)}
                    onClick={() => onSelect?.(d.function)}
                    style={{ cursor: onSelect ? "pointer" : "default" }}
                  >
                    <span className="w-32 shrink-0 truncate font-mono text-xs text-muted-foreground group-hover:text-foreground transition-colors">
                      {d.function}
                    </span>
                    <div className="relative flex h-3.5 flex-1 items-center overflow-hidden rounded-full bg-muted">
                      {/* Vertical gridlines at 25/50/75% so scale is legible even when this
                          row's bar is short or empty */}
                      {[25, 50, 75].map((pct) => (
                        <span key={pct} className="absolute top-0 bottom-0 w-px bg-border/80" style={{ left: `${pct}%` }} />
                      ))}
                      <div className="relative h-full rounded-l-full bg-primary transition-all" style={{ width: `${inPct}%` }} />
                      <div className="relative h-full bg-primary/25 transition-all" style={{ width: `${outPct}%` }} />
                    </div>
                    <span className="w-16 shrink-0 text-right tabular-nums text-xs font-mono text-muted-foreground">
                      {total.toLocaleString()}
                    </span>
                  </div>
                );
              })}
            </div>

            {/* "Show all" toggle — only appears when there are more rows
                than the default cap. Avoids an endlessly tall chart for
                swarms with many functions while keeping the data accessible. */}
            {hiddenCount > 0 && (
              <button
                onClick={() => setShowAll((v) => !v)}
                className="mt-3 w-full text-center text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors py-1"
              >
                {showAll ? "Show fewer" : `Show ${hiddenCount} more function${hiddenCount !== 1 ? "s" : ""}`}
              </button>
            )}
          </>
        )}
      </div>

      {hover && (
        <div
          className="pointer-events-none fixed z-50 max-w-xs rounded-xl border border-border bg-card px-3 py-2 text-xs"
          style={{
            left: Math.min(hover.x + 12, (typeof window !== 'undefined' ? window.innerWidth : 1280) - 240),
            top: Math.max(8, hover.y - 60),
          }}
        >
          <div className="font-semibold text-foreground">{hover.fn}</div>
          <div className="mt-1 font-mono text-muted-foreground">
            <span className="text-primary">in</span> {hover.input.toLocaleString()}
            {" · "}
            <span className="text-primary/60">out</span> {hover.output.toLocaleString()}
          </div>
          <div className="mt-0.5 font-mono text-foreground font-semibold">
            {hover.total.toLocaleString()} total
          </div>
        </div>
      )}
    </div>
  );
}
