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

  const rowH   = 36;
  const labelW = 164;
  const ticks  = 5;

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
                    return (
                      <button
                        key={t.id}
                        onClick={() => onSelect(t)}
                        onMouseEnter={(e) => setHover({ t, x: e.clientX, y: e.clientY })}
                        onMouseLeave={() => setHover(null)}
                        aria-label={`${t.function}, ${t.latency_sec.toFixed(2)} seconds, ${ok ? "ok" : "error"}. ${t.id}`}
                        title={`${t.function} — ${t.latency_sec.toFixed(2)}s`}
                        className={`absolute top-1/2 -translate-y-1/2 rounded transition-all hover:brightness-110 hover:scale-y-125 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring ${
                          ok ? "bg-primary" : "bg-destructive"
                        }`}
                        style={{ left: `${startOff}%`, width: `${width}%`, height: rowH - 16, minWidth: 4 }}
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
              // off-screen on the right or bottom edges (the old code used
              // raw clientX/Y which could push it past the viewport).
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