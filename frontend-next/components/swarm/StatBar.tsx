'use client'

import { useState, useEffect } from "react";
import type { Trace } from "@/lib/trace-types";
import { Activity, Clock, Coins, Hash, Menu } from "lucide-react";
import { UsageBreakdownDrawer } from "./UsageBreakdownDrawer";

function StatCard({ label, value, unit, icon: Icon, trend, onMenuClick, menuLabel }: {
  label: string;
  value: string;
  unit?: string;
  icon: React.ComponentType<{ className?: string }>;
  trend?: string;
  onMenuClick?: () => void;
  menuLabel?: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-5 shadow-sm hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between mb-4">
        <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{label}</div>
        <div className="flex items-center gap-1.5">
          {onMenuClick && (
            <button
              onClick={onMenuClick}
              title={menuLabel}
              aria-label={menuLabel}
              className="w-8 h-8 rounded-lg border border-border bg-card flex items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground hover:border-zinc-300 transition-colors"
            >
              <Menu className="w-4 h-4" />
            </button>
          )}
          <div className="w-10 h-10 rounded-lg border border-border bg-muted/60 flex items-center justify-center shrink-0">
            <Icon className="w-[18px] h-[18px] text-muted-foreground" />
          </div>
        </div>
      </div>
      <div className="text-4xl font-bold tabular-nums text-foreground leading-none tracking-tight">
        {value}
        {unit && <span className="ml-1.5 text-base font-medium text-muted-foreground">{unit}</span>}
      </div>
      {trend && <div className="mt-2.5 text-xs text-muted-foreground">{trend}</div>}
    </div>
  );
}

export function StatBar({ traces }: { traces: Trace[] }) {
  const [drawerOpen, setDrawerOpen] = useState(false);

  const totalLat    = traces.filter((t) => !t.parent_id || !traces.some((x) => x.id === t.parent_id)).reduce((s, t) => s + t.latency_sec, 0);
  const totalTokens = traces.reduce((s, t) => s + t.input_tokens + t.output_tokens, 0);
  const totalCost   = traces.reduce((s, t) => s + t.cost_usd, 0);
  const errors      = traces.filter((t) => t.error).length;
  const successRate = traces.length > 0 ? (((traces.length - errors) / traces.length) * 100).toFixed(1) : "100.0";

  // Lock body scroll when drawer is open
  useEffect(() => {
    if (drawerOpen) {
      document.body.style.overflow = "hidden";
      return () => { document.body.style.overflow = ""; };
    }
  }, [drawerOpen]);

  return (
    <>
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
        <StatCard label="Total Traces"  value={String(traces.length)} icon={Hash}     trend={`${errors} error${errors !== 1 ? "s" : ""} · ${successRate}% success`} />
        <StatCard label="Total Latency" value={totalLat.toFixed(2)}   icon={Clock}    unit="s" trend={`avg ${traces.length ? (totalLat / traces.length).toFixed(2) : "0"}s per trace`} />
        <StatCard
          label="Token Usage"
          value={totalTokens.toLocaleString()}
          icon={Activity}
          trend={`${traces.reduce((s,t)=>s+t.input_tokens,0).toLocaleString()} in / ${traces.reduce((s,t)=>s+t.output_tokens,0).toLocaleString()} out`}
          onMenuClick={() => setDrawerOpen(true)}
          menuLabel="View usage breakdown"
        />
        <StatCard
          label="Total Cost"
          value={`$${totalCost.toFixed(4)}`}
          icon={Coins}
          trend={`avg $${traces.length ? (totalCost / traces.length).toFixed(4) : "0"} per trace`}
          onMenuClick={() => setDrawerOpen(true)}
          menuLabel="View spend breakdown"
        />
      </div>

      <UsageBreakdownDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
    </>
  );
}
