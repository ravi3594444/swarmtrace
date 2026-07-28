'use client'

import type { Trace } from "@/lib/trace-types";
import { useState } from "react";

export function Waterfall({ traces, onSelect }: { traces: Trace[]; onSelect: (t: Trace) => void }) {
  const [hover, setHover] = useState<{ t: Trace; x: number; y: number } | null>(null);

  if (traces.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
        No traces to plot.
      </div>
    );
  }

  const startMs = Math.min(...traces.map((t) => new Date(t.timestamp).getTime()));
  const endMs   = Math.max(...traces.map((t) => new Date(t.timestamp).getTime() + t.latency_sec * 1000));
  const totalMs = Math.max(endMs - startMs, 1);

  const fnOrder: string[] = [];
  traces.forEach((t) => { if (!fnOrder.includes(t.function)) fnOrder.push(t.function); });

  // Row height grows with the max number of overlapping traces per function
  // so bars never fully overlap. Previously every function got a fixed 36px
  // row and 50 overlapping bars stacked on the exact same line — now the
  // row height scales (up to a cap) and bars are vertically distributed
  // across the available space. The vertical offset per trace is computed
  // from its index within the function's traces, so consecutive calls
  // fan out instead of hiding each other.
  const barH = 8;       // individual bar height
  const barGap = 2;     // gap between stacked bars
  const labelW = 164;
  const ticks  = 5;

  // Compute per-function trace counts to size rows.
  const fnCounts = new Map<string, number>();
  traces.forEach((t) => fnCounts.set(t.function, (fnCounts.get(t.function) ?? 0) + 1));

  // Per-function running index — used to assign each trace a vertical slot
  // within its row so overlapping calls fan out instead of stacking.
  const fnIndex = new Map<string, number>();

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="flex items-center justify-between border-b border-border bg-muted/40 px-4 py-3">
        <h3 className="text-sm font-semibold text-foreground">Waterfall</h3>
        <span className="font-mono text-[10px] text-muted-foreground">
          {(totalMs / 1000).toFixed(2)}s total span
        </span>
      </div>

      <div className="relative overflow-x-auto p-4">
        <div style={{ minWidth: 560 }}>
          {/* Tick header */}
          <div className="relative mb-2 h-5 font-mono text-[10px] text-muted-foreground" style={{ marginLeft: labelW }}>
            {Array.from({ length: ticks + 1 }).map((_, i) => (
              <div key={i} className="absolute top-0 -translate-x-1/2" style={{ left: `${(i / ticks) * 100}%` }}>
                {((totalMs * i) / ticks / 1000).toFixed(2)}s
              </div>
            ))}
          </div>

          {fnOrder.map((fn) => {
            const rowTraces = traces.filter((t) => t.function === fn);
            const count = fnCounts.get(fn) ?? 1;
            // Row height scales with the number of traces, capped so a
            // function with hundreds of calls doesn't dominate the chart.
            const rowH = Math.min(36 + count * (barH + barGap), 200);
            return (
              <div key={fn} className="relative flex items-center border-t border-border/40" style={{ height: rowH }}>
                <div className="shrink-0 pr-3 font-mono text-xs text-muted-foreground truncate" style={{ width: labelW }} title={fn}>
                  {fn}
                </div>
                <div className="relative h-full flex-1">
                  {Array.from({ length: ticks + 1 }).map((_, i) => (
                    <div key={i} className="absolute top-0 h-full w-px bg-border/50" style={{ left: `${(i / ticks) * 100}%` }} />
                  ))}
                  {rowTraces.map((t) => {
                    const startOff = ((new Date(t.timestamp).getTime() - startMs) / totalMs) * 100;
                    const width    = Math.max(((t.latency_sec * 1000) / totalMs) * 100, 0.8);
                    const ok       = !t.error;
                    // Assign a vertical slot within the row. The index resets
                    // per function so each function's traces fan out from top
                    // to bottom of its row.
                    const idx = fnIndex.get(fn) ?? 0;
                    fnIndex.set(fn, idx + 1);
                    const top = 4 + idx * (barH + barGap);
                    return (
                      <button
                        key={t.id}
                        onClick={() => onSelect(t)}
                        onMouseEnter={(e) => setHover({ t, x: e.clientX, y: e.clientY })}
                        onMouseLeave={() => setHover(null)}
                        aria-label={`${t.function}, ${t.latency_sec.toFixed(2)} seconds, ${ok ? "ok" : "error"}. ${t.id}`}
                        title={`${t.function} — ${t.latency_sec.toFixed(2)}s`}
                        className={`absolute rounded transition-all hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring ${
                          ok ? "bg-primary" : "bg-destructive"
                        }`}
                        style={{ left: `${startOff}%`, width: `${width}%`, height: barH, minWidth: 4, top }}
                      />
                    );
                  })}
                </div>
                <div className="w-8 shrink-0 pl-2 text-right font-mono text-[10px] text-muted-foreground">
                  {rowTraces.length}×
                </div>
              </div>
            );
          })}
        </div>

        {hover && (
          <div
            className="pointer-events-none fixed z-50 max-w-xs rounded-xl border border-border bg-card px-3 py-2 text-xs"
            style={{
              // Clamp the tooltip to the viewport so it never renders
              // off-screen on the right or bottom edges.
              left: Math.min(hover.x + 12, (typeof window !== 'undefined' ? window.innerWidth : 1280) - 260),
              top: Math.max(8, hover.y - 50),
            }}
          >
            <div className="font-semibold text-foreground">{hover.t.function}</div>
            <div className="mt-0.5 font-mono text-muted-foreground">{hover.t.id}</div>
            <div className="mt-1 font-mono text-muted-foreground">
              {hover.t.latency_sec.toFixed(2)}s · {hover.t.input_tokens + hover.t.output_tokens} tok
            </div>
            {hover.t.error && <div className="mt-1 text-destructive">{hover.t.error}</div>}
          </div>
        )}
      </div>
    </div>
  );
}
