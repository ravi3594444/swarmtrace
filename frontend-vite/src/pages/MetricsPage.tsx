import { useState, useEffect } from "react";
import { DEMO_DAILY_METRICS } from "@/lib/traces-data";
import { LoadingScreen } from "@/components/LoadingScreen";
import { PageHeader } from "@/components/Layout";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, LineChart, Line, Legend } from "recharts";
import { Download } from "lucide-react";

const MODEL_DATA = [
  { model: "gpt-4o",      calls: 42, cost: 0.182 },
  { model: "claude-3.5",  calls: 28, cost: 0.121 },
  { model: "gemini-pro",  calls: 14, cost: 0.031 },
  { model: "gpt-4o-mini", calls: 66, cost: 0.049 },
];

const chartTooltip = {
  contentStyle: {
    background: "#ffffff",
    border: "1px solid hsl(220, 13%, 88%)",
    borderRadius: 10,
    fontSize: 12,
    boxShadow: "0 4px 20px rgba(0,0,0,0.08)",
    fontFamily: "Inter, sans-serif",
  },
  labelStyle:  { color: "#141414", fontWeight: 600 },
  itemStyle:   { color: "#141414" },
};

function MetricCard({ label, value, unit, trend }: { label: string; value: string; unit?: string; trend: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">{label}</div>
      <div className="text-2xl font-bold tabular-nums text-foreground">
        {value}{unit && <span className="ml-1 text-sm font-normal text-muted-foreground">{unit}</span>}
      </div>
      <div className="mt-2 text-xs text-muted-foreground">{trend}</div>
    </div>
  );
}

export default function MetricsPage() {
  const [loading, setLoading] = useState(true);

  useEffect(() => { const t = setTimeout(() => setLoading(false), 900); return () => clearTimeout(t); }, []);

  const exportCSV = () => {
    const rows = DEMO_DAILY_METRICS.map((r) => `${r.day},${r.input},${r.output},${r.cost},${r.traces}`).join("\n");
    const blob = new Blob(["day,input_tokens,output_tokens,cost_usd,traces\n" + rows], { type: "text/csv" });
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "swarmtrace-metrics.csv" });
    a.click(); URL.revokeObjectURL(a.href);
  };

  if (loading) return <LoadingScreen message="Crunching metrics..." />;

  const totalTokens = DEMO_DAILY_METRICS.reduce((s, d) => s + d.input + d.output, 0);
  const totalCost   = DEMO_DAILY_METRICS.reduce((s, d) => s + d.cost, 0);
  const totalTraces = DEMO_DAILY_METRICS.reduce((s, d) => s + d.traces, 0);

  return (
    <>
      <PageHeader
        title="Metrics"
        description="Token usage, cost, and throughput analytics"
        actions={
          <button onClick={exportCSV} className="flex items-center gap-1.5 h-8 rounded-lg border border-border bg-card px-3 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors shadow-sm">
            <Download className="w-3.5 h-3.5" />Export CSV
          </button>
        }
      />

      <div className="p-6 space-y-6">
        <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
          <MetricCard label="Total Tokens" value={totalTokens.toLocaleString()} trend="+18% from last week" />
          <MetricCard label="Total Cost"   value={`$${totalCost.toFixed(3)}`}   trend="+12% from last week" />
          <MetricCard label="Traces"       value={String(totalTraces)}           trend="+24% from last week" />
          <MetricCard label="Avg / Trace"  value={`$${(totalCost / totalTraces).toFixed(4)}`} trend="-3% efficiency gain" />
        </div>

        {/* Token usage */}
        <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
          <div className="flex items-center justify-between border-b border-border bg-muted/30 px-4 py-3">
            <h3 className="text-sm font-semibold text-foreground">Daily Token Usage</h3>
            <span className="text-[11px] text-muted-foreground">past 7 days</span>
          </div>
          <div className="p-4 h-52">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={DEMO_DAILY_METRICS} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(220, 13%, 91%)" vertical={false} />
                <XAxis dataKey="day" tick={{ fill: "hsl(0,0%,44%)", fontSize: 11, fontFamily: "Inter, sans-serif" }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: "hsl(0,0%,44%)", fontSize: 10, fontFamily: "Inter, sans-serif" }} axisLine={false} tickLine={false} width={42} tickFormatter={(v) => `${(v/1000).toFixed(0)}k`} />
                <Tooltip {...chartTooltip} />
                <Legend wrapperStyle={{ fontSize: 11, color: "hsl(0,0%,44%)", fontFamily: "Inter, sans-serif" }} />
                <Bar dataKey="input"  name="Input"  fill="hsl(250, 84%, 54%)" radius={[4, 4, 0, 0]} maxBarSize={32} />
                <Bar dataKey="output" name="Output" fill="hsl(250, 84%, 80%)" radius={[4, 4, 0, 0]} maxBarSize={32} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
          {/* Cost trend */}
          <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
            <div className="flex items-center justify-between border-b border-border bg-muted/30 px-4 py-3">
              <h3 className="text-sm font-semibold text-foreground">Daily Cost (USD)</h3>
            </div>
            <div className="p-4 h-48">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={DEMO_DAILY_METRICS} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(220, 13%, 91%)" vertical={false} />
                  <XAxis dataKey="day" tick={{ fill: "hsl(0,0%,44%)", fontSize: 11, fontFamily: "Inter, sans-serif" }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fill: "hsl(0,0%,44%)", fontSize: 10, fontFamily: "Inter, sans-serif" }} axisLine={false} tickLine={false} width={46} tickFormatter={(v) => `$${v.toFixed(2)}`} />
                  <Tooltip {...chartTooltip} formatter={(v: number) => [`$${v.toFixed(3)}`, "Cost"]} />
                  <Line type="monotone" dataKey="cost" stroke="hsl(250, 84%, 54%)" strokeWidth={2} dot={{ fill: "hsl(250, 84%, 54%)", strokeWidth: 0, r: 3 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Model breakdown */}
          <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
            <div className="flex items-center justify-between border-b border-border bg-muted/30 px-4 py-3">
              <h3 className="text-sm font-semibold text-foreground">Model Breakdown</h3>
            </div>
            <div className="divide-y divide-border/50">
              {MODEL_DATA.map((m) => {
                const maxCalls = Math.max(...MODEL_DATA.map((x) => x.calls));
                return (
                  <div key={m.model} className="flex items-center gap-4 px-4 py-3">
                    <div className="w-28 shrink-0 text-xs text-foreground font-medium">{m.model}</div>
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                          <div className="h-full bg-primary rounded-full" style={{ width: `${(m.calls / maxCalls) * 100}%` }} />
                        </div>
                        <span className="w-10 text-right text-xs text-muted-foreground">{m.calls}×</span>
                      </div>
                    </div>
                    <div className="w-16 text-right text-xs font-semibold text-foreground">${m.cost.toFixed(3)}</div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Trace volume */}
        <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
          <div className="flex items-center justify-between border-b border-border bg-muted/30 px-4 py-3">
            <h3 className="text-sm font-semibold text-foreground">Trace Volume</h3>
          </div>
          <div className="p-4 h-48">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={DEMO_DAILY_METRICS} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(220, 13%, 91%)" vertical={false} />
                <XAxis dataKey="day" tick={{ fill: "hsl(0,0%,44%)", fontSize: 11, fontFamily: "Inter, sans-serif" }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: "hsl(0,0%,44%)", fontSize: 10, fontFamily: "Inter, sans-serif" }} axisLine={false} tickLine={false} width={28} />
                <Tooltip {...chartTooltip} />
                <Bar dataKey="traces" name="Traces" fill="hsl(250, 84%, 54%)" radius={[4, 4, 0, 0]} maxBarSize={36} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </>
  );
}
