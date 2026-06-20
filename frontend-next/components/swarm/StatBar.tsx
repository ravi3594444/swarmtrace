'use client'

import type { Trace } from "@/lib/trace-types";
import { Activity, Clock, Coins, Hash } from "lucide-react";

function StatCard({ label, value, unit, icon: Icon, trend }: {
  label: string;
  value: string;
  unit?: string;
  icon: React.ComponentType<{ className?: string }>;
  trend?: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-5 shadow-sm hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between mb-3">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{label}</div>
        <div className="w-8 h-8 rounded-lg border border-border bg-muted/50 flex items-center justify-center shrink-0">
          <Icon className="w-4 h-4 text-muted-foreground" />
        </div>
      </div>
      <div className="text-2xl font-bold tabular-nums text-foreground">
        {value}
        {unit && <span className="ml-1 text-sm font-normal text-muted-foreground">{unit}</span>}
      </div>
      {trend && <div className="mt-1.5 text-xs text-muted-foreground">{trend}</div>}
    </div>
  );
}

export function StatBar({ traces }: { traces: Trace[] }) {
  const totalLat    = traces.filter((t) => !t.parent_id || !traces.some((x) => x.id === t.parent_id)).reduce((s, t) => s + t.latency_sec, 0);
  const totalTokens = traces.reduce((s, t) => s + t.input_tokens + t.output_tokens, 0);
  const totalCost   = traces.reduce((s, t) => s + t.cost_usd, 0);
  const errors      = traces.filter((t) => t.error).length;
  const successRate = traces.length > 0 ? (((traces.length - errors) / traces.length) * 100).toFixed(1) : "100.0";

  return (
    <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
      <StatCard label="Total Traces"  value={String(traces.length)} icon={Hash}     trend={`${errors} error${errors !== 1 ? "s" : ""} · ${successRate}% success`} />
      <StatCard label="Total Latency" value={totalLat.toFixed(2)}   icon={Clock}    unit="s" trend={`avg ${traces.length ? (totalLat / traces.length).toFixed(2) : "0"}s per trace`} />
      <StatCard label="Token Usage"   value={totalTokens.toLocaleString()} icon={Activity} trend={`${traces.reduce((s,t)=>s+t.input_tokens,0).toLocaleString()} in / ${traces.reduce((s,t)=>s+t.output_tokens,0).toLocaleString()} out`} />
      <StatCard label="Total Cost"    value={`$${totalCost.toFixed(4)}`}   icon={Coins}    trend={`avg $${traces.length ? (totalCost / traces.length).toFixed(4) : "0"} per trace`} />
    </div>
  );
}