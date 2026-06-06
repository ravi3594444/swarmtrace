import type { Trace } from "@/lib/traces-data";

function Stat({
  label,
  value,
  unit,
  accent = false,
  cornerTick = false,
}: {
  label: string;
  value: string;
  unit?: string;
  accent?: boolean;
  cornerTick?: boolean;
}) {
  return (
    <div className="relative overflow-hidden border border-border bg-card p-5 transition hover:border-border/60">
      <div className="absolute left-0 top-0 h-full w-px bg-primary/20" />
      {cornerTick && (
        <div className="absolute right-2 top-2 h-1 w-1 bg-primary" />
      )}
      <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </div>
      <div
        className={`mt-3 font-mono tabular-nums ${accent ? "text-primary" : "text-foreground"}`}
        style={{ fontSize: "2rem", lineHeight: 1.05, fontWeight: 300 }}
      >
        {value}
        {unit && <span className="ml-0.5 text-base text-muted-foreground/60">{unit}</span>}
      </div>
    </div>
  );
}

export function StatBar({ traces }: { traces: Trace[] }) {
  const roots = traces.filter(
    (t) => !t.parent_id || !traces.some((x) => x.id === t.parent_id),
  );
  const totalLatency = roots.reduce((s, t) => s + t.latency_sec, 0);
  const totalTokens = traces.reduce((s, t) => s + t.input_tokens + t.output_tokens, 0);
  const totalCost = traces.reduce((s, t) => s + t.cost_usd, 0);

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <Stat label="Total Traces" value={String(traces.length).padStart(2, "0")} />
      <Stat label="Total Latency" value={totalLatency.toFixed(2)} unit="s" />
      <Stat label="Total Tokens" value={totalTokens.toLocaleString()} />
      <Stat label="Total Cost" value={`$${totalCost.toFixed(4)}`} accent cornerTick />
    </div>
  );
}
