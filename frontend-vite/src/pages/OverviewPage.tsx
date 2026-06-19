import { useState } from "react";
import { useTraces } from "@/hooks/use-traces";
import { DEMO_ACTIVITY, DEMO_EVENTS } from "@/lib/traces-data";
import { StatBar }      from "@/components/swarm/StatBar";
import { CallTree }     from "@/components/swarm/CallTree";
import { TokenChart }   from "@/components/swarm/TokenChart";
import { DetailDrawer } from "@/components/swarm/DetailDrawer";
import { LoadingScreen } from "@/components/LoadingScreen";
import { PageHeader }   from "@/components/Layout";
import type { Trace }   from "@/lib/traces-data";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { Activity, Info, Database } from "lucide-react";

const chartTooltip = {
  contentStyle: { background: "#ffffff", border: "1px solid hsl(220,13%,88%)", borderRadius: 10, fontSize: 12, boxShadow: "0 4px 20px rgba(0,0,0,0.08)", fontFamily: "Inter,sans-serif" },
  labelStyle: { color: "#141414", fontWeight: 600 },
  itemStyle:  { color: "#141414" },
};

export default function OverviewPage() {
  const { traces, loading, source, isLive } = useTraces(10000);
  const [selected, setSelected] = useState<Trace | null>(null);

  if (loading) return <LoadingScreen message="Connecting to swarm…" />;

  const errorCount  = traces.filter(t => t.error).length;
  const totalTokens = traces.reduce((s, t) => s + t.input_tokens + t.output_tokens, 0);
  const avgLatency  = traces.length ? traces.reduce((s, t) => s + t.latency_sec, 0) / traces.length : 0;

  return (
    <>
      <PageHeader
        title="Overview"
        description="Live swarm health and execution summary"
        liveStatus={isLive ? "live" : "paused"}
        actions={
          <div className="flex items-center gap-3">
            {source === "demo" && (
              <span className="flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[10px] font-semibold text-amber-700">
                <Database className="w-3 h-3" /> DEMO DATA
              </span>
            )}
            <span className="flex items-center gap-3 text-xs font-medium text-muted-foreground">
              <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-emerald-500" />{traces.length - errorCount} ok</span>
              <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-red-400" />{errorCount} errors</span>
            </span>
          </div>
        }
      />

      <div className="p-6 space-y-6">
        <StatBar traces={traces} />

        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
          <div className="xl:col-span-2 rounded-xl border border-border bg-card shadow-sm overflow-hidden">
            <div className="flex items-center justify-between border-b border-border bg-muted/30 px-4 py-3">
              <div className="flex items-center gap-2"><Activity className="w-4 h-4 text-muted-foreground" /><h3 className="text-sm font-semibold text-foreground">Request Activity</h3></div>
              <span className="text-[11px] text-muted-foreground">last 24h</span>
            </div>
            <div className="p-4 h-44">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={DEMO_ACTIVITY} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="colorReq" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor="hsl(250,84%,54%)" stopOpacity={0.15} />
                      <stop offset="95%" stopColor="hsl(250,84%,54%)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(220,13%,90%)" vertical={false} />
                  <XAxis dataKey="time" tick={{ fill: "hsl(0,0%,44%)", fontSize: 11 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fill: "hsl(0,0%,44%)", fontSize: 10 }} axisLine={false} tickLine={false} width={28} />
                  <Tooltip {...chartTooltip} />
                  <Area type="monotone" dataKey="requests" stroke="hsl(250,84%,54%)" strokeWidth={2} fill="url(#colorReq)" dot={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
            <div className="flex items-center justify-between border-b border-border bg-muted/30 px-4 py-3">
              <div className="flex items-center gap-2"><Info className="w-4 h-4 text-muted-foreground" /><h3 className="text-sm font-semibold text-foreground">Live Events</h3></div>
              <span className="text-[11px] text-muted-foreground flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500 swarm-pulse" />LIVE</span>
            </div>
            <div className="divide-y divide-border/50 overflow-y-auto max-h-44">
              {traces.slice(0, 6).map(t => (
                <div key={t.id} className="flex items-start gap-3 px-4 py-3 hover:bg-muted/30 transition-colors">
                  <span className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[9px] font-bold uppercase mt-0.5 ${t.error ? "bg-red-50 text-red-700 border-red-200" : "bg-muted text-muted-foreground border-border"}`}>
                    {t.error ? "ERROR" : "INFO"}
                  </span>
                  <p className="text-xs text-foreground leading-relaxed min-w-0 truncate">
                    {t.error ? `${t.function}: ${t.error}` : `${t.function} completed in ${t.latency_sec.toFixed(2)}s`}
                  </p>
                </div>
              ))}
              {traces.length === 0 && DEMO_EVENTS.map(e => (
                <div key={e.id} className="flex items-start gap-3 px-4 py-3 hover:bg-muted/30 transition-colors">
                  <span className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[9px] font-bold uppercase mt-0.5 ${e.type === "ERROR" ? "bg-red-50 text-red-700 border-red-200" : e.type === "WARN" ? "bg-amber-50 text-amber-700 border-amber-200" : "bg-muted text-muted-foreground border-border"}`}>{e.type}</span>
                  <p className="text-xs text-foreground leading-relaxed min-w-0 break-words">{e.message}</p>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-4">
          {[
            { label: "Total Spans",  value: traces.length.toString(),          sub: `${errorCount} in error state` },
            { label: "Tokens / Span", value: traces.length ? Math.round(totalTokens / traces.length).toLocaleString() : "0", sub: "avg per span" },
            { label: "Avg Latency",  value: `${avgLatency.toFixed(2)}s`,       sub: "across all spans" },
          ].map(c => (
            <div key={c.label} className="rounded-xl border border-border bg-card p-5 shadow-sm">
              <div className="text-xs text-muted-foreground uppercase tracking-wider mb-2 font-medium">{c.label}</div>
              <div className="text-2xl font-bold tabular-nums text-foreground">{c.value}</div>
              <div className="text-xs text-muted-foreground mt-1">{c.sub}</div>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
          <CallTree traces={traces} onSelect={setSelected} />
          <TokenChart traces={traces} />
        </div>
      </div>

      <DetailDrawer trace={selected} allTraces={traces} onClose={() => setSelected(null)} onJump={setSelected} />
    </>
  );
}
