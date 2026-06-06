import type { Trace } from "@/lib/traces-data";
import { useState } from "react";

export function Waterfall({
  traces,
  onSelect,
}: {
  traces: Trace[];
  onSelect: (t: Trace) => void;
}) {
  const [hover, setHover] = useState<{ t: Trace; x: number; y: number } | null>(null);

  if (traces.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card p-8 text-center text-sm text-muted-foreground">
        No traces to plot.
      </div>
    );
  }

  const startMs = Math.min(...traces.map((t) => new Date(t.timestamp).getTime()));
  const endMs = Math.max(
    ...traces.map((t) => new Date(t.timestamp).getTime() + t.latency_sec * 1000),
  );
  const totalMs = Math.max(endMs - startMs, 1);

  // Stable Y order: by first appearance per function name
  const fnOrder: string[] = [];
  traces.forEach((t) => {
    if (!fnOrder.includes(t.function)) fnOrder.push(t.function);
  });

  const rowH = 32;
  const labelW = 160;
  const ticks = 6;

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border bg-muted/30 px-4 py-2.5 font-mono text-[11px] uppercase tracking-[0.16em] font-bold text-muted-foreground">
        <span>Waterfall</span>
        <span className="text-[10px] text-muted-foreground/60">{(totalMs / 1000).toFixed(2)}s SPAN</span>
      </div>
      <div className="relative overflow-x-auto p-4">
        <div style={{ minWidth: 640 }}>
          {/* tick header */}
          <div className="relative mb-2 h-5" style={{ marginLeft: labelW }}>
            {Array.from({ length: ticks + 1 }).map((_, i) => {
              const pct = (i / ticks) * 100;
              const ms = (totalMs * i) / ticks;
              return (
                <div
                  key={i}
                  className="absolute top-0 -translate-x-1/2 font-mono text-[10px] text-muted-foreground"
                  style={{ left: `${pct}%` }}
                >
                  {(ms / 1000).toFixed(2)}s
                </div>
              );
            })}
          </div>

          {fnOrder.map((fn, rowIdx) => {
            const rowTraces = traces.filter((t) => t.function === fn);
            return (
              <div
                key={fn}
                className="relative flex items-center border-t border-border/60"
                style={{ height: rowH }}
              >
                <div
                  className="shrink-0 truncate pr-3 font-mono text-xs text-muted-foreground"
                  style={{ width: labelW }}
                  title={fn}
                >
                  {fn}
                </div>
                <div className="relative h-full flex-1">
                  {/* gridlines */}
                  {Array.from({ length: ticks + 1 }).map((_, i) => (
                    <div
                      key={i}
                      className="absolute top-0 h-full w-px bg-border/40"
                      style={{ left: `${(i / ticks) * 100}%` }}
                    />
                  ))}
                  {rowTraces.map((t) => {
                    const startOffset =
                      ((new Date(t.timestamp).getTime() - startMs) / totalMs) * 100;
                    const width = Math.max(((t.latency_sec * 1000) / totalMs) * 100, 0.6);
                    const ok = !t.error;
                    return (
                      <button
                        key={t.id}
                        onClick={() => onSelect(t)}
                        onMouseEnter={(e) =>
                          setHover({
                            t,
                            x: e.currentTarget.getBoundingClientRect().left,
                            y: e.currentTarget.getBoundingClientRect().top,
                          })
                        }
                        onMouseLeave={() => setHover(null)}
                        className={`absolute top-1/2 -translate-y-1/2 rounded transition hover:brightness-125 ${
                          ok ? "bg-primary" : "bg-destructive"
                        }`}
                        style={{
                          left: `${startOffset}%`,
                          width: `${width}%`,
                          height: rowH - 12,
                          minWidth: 4,
                        }}
                        title={`${t.function} · ${t.latency_sec.toFixed(2)}s`}
                      />
                    );
                  })}
                </div>
                <div className="w-12 shrink-0 pl-2 text-right font-mono text-[10px] text-muted-foreground">
                  {rowTraces.length}×
                </div>
                {rowIdx === fnOrder.length - 1 && (
                  <div className="absolute -bottom-px left-0 right-0 border-t border-border/60" />
                )}
              </div>
            );
          })}
        </div>

        {hover && (
          <div
            className="pointer-events-none fixed z-50 max-w-xs rounded border border-border bg-popover px-3 py-2 text-xs shadow-xl"
            style={{ left: hover.x, top: hover.y - 60 }}
          >
            <div className="font-semibold text-foreground">{hover.t.function}</div>
            <div className="mt-0.5 font-mono text-muted-foreground">{hover.t.id}</div>
            <div className="mt-1 font-mono text-muted-foreground">
              {hover.t.latency_sec.toFixed(2)}s · {hover.t.input_tokens + hover.t.output_tokens} tok
            </div>
            {hover.t.error && (
              <div className="mt-1 text-destructive">{hover.t.error}</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
