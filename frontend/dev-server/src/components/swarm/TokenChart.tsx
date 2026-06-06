import type { Trace } from "@/lib/traces-data";

export function TokenChart({ traces }: { traces: Trace[] }) {
  const byFn = new Map<string, { function: string; input: number; output: number }>();
  traces.forEach((t) => {
    const cur = byFn.get(t.function) ?? { function: t.function, input: 0, output: 0 };
    cur.input += t.input_tokens;
    cur.output += t.output_tokens;
    byFn.set(t.function, cur);
  });
  const data = Array.from(byFn.values()).sort((a, b) => b.input + b.output - (a.input + a.output));
  const max = Math.max(1, ...data.map((d) => d.input + d.output));

  return (
    <div className="border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border bg-muted/30 px-4 py-2.5 font-mono text-[11px] uppercase tracking-[0.16em] font-bold text-muted-foreground">
        <span>Token burn by function</span>
        <span className="flex items-center gap-4 text-[10px] text-muted-foreground/70">
          <span className="flex items-center gap-1.5">
            <span className="h-1.5 w-3 bg-primary" /> INPUT
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-1.5 w-3 bg-primary/30" /> OUTPUT
          </span>
        </span>
      </div>
      <div className="space-y-2 p-5 font-mono text-[11px]">
        {data.length === 0 && (
          <div className="py-8 text-center text-muted-foreground/60">No data</div>
        )}
        {data.map((d) => {
          const total = d.input + d.output;
          const inPct = (d.input / max) * 100;
          const outPct = (d.output / max) * 100;
          return (
            <div key={d.function} className="group flex items-center gap-3">
              <span className="w-32 shrink-0 truncate text-foreground/80">{d.function}</span>
              <div className="relative flex h-5 flex-1 items-center overflow-hidden bg-muted/40">
                <div className="h-full bg-primary transition-all" style={{ width: `${inPct}%` }} />
                <div className="h-full bg-primary/30 transition-all" style={{ width: `${outPct}%` }} />
              </div>
              <span className="w-16 shrink-0 text-right tabular-nums text-muted-foreground">
                {total.toLocaleString()}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
