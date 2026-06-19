import { useState, useEffect } from "react";
import { DEMO_AGENTS } from "@/lib/agents-data";
import { LoadingScreen } from "@/components/LoadingScreen";
import { PageHeader } from "@/components/Layout";
import type { Agent } from "@/lib/agents-data";
import { Activity, Clock, CheckCircle2, XCircle, Pause, RefreshCw, Search } from "lucide-react";

function StatusBadge({ status }: { status: Agent["status"] }) {
  if (status === "RUNNING") return (
    <span className="flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-bold text-emerald-700">
      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 swarm-pulse" />RUNNING
    </span>
  );
  if (status === "ERROR") return (
    <span className="flex items-center gap-1.5 rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-[10px] font-bold text-red-700">
      <XCircle className="w-2.5 h-2.5" />ERROR
    </span>
  );
  return (
    <span className="flex items-center gap-1.5 rounded-full border border-border bg-muted/60 px-2 py-0.5 text-[10px] font-bold text-muted-foreground">
      <Pause className="w-2.5 h-2.5" />IDLE
    </span>
  );
}

function AgentCard({ agent }: { agent: Agent }) {
  const isRunning = agent.status === "RUNNING";
  const isError   = agent.status === "ERROR";

  return (
    <div className={`rounded-xl border bg-card shadow-sm overflow-hidden transition-all hover:shadow-md ${
      isError ? "border-red-200" : "border-border"
    }`}>
      <div className={`h-1 ${isRunning ? "bg-primary" : isError ? "bg-red-400" : "bg-border"}`} />
      <div className="p-5">
        <div className="flex items-start justify-between gap-3 mb-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1.5">
              <span className={`w-2 h-2 rounded-full shrink-0 ${isRunning ? "bg-emerald-500 swarm-pulse" : isError ? "bg-red-400" : "bg-muted-foreground/30"}`} />
              <h3 className="text-sm font-semibold text-foreground truncate">{agent.name}</h3>
            </div>
            <div className="flex items-center gap-2">
              <StatusBadge status={agent.status} />
              <span className="text-[11px] text-muted-foreground">{agent.id}</span>
            </div>
          </div>
        </div>

        <div className={`rounded-lg border px-3 py-2 mb-4 ${isError ? "border-red-200 bg-red-50" : "border-border bg-muted/30"}`}>
          <div className="text-[10px] font-medium text-muted-foreground mb-0.5">Current Task</div>
          <p className="text-xs truncate font-medium text-foreground">{agent.current_task}</p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          {[
            { label: "Tasks",   value: String(agent.tasks), icon: Activity     },
            { label: "Success", value: agent.success_rate,  icon: CheckCircle2 },
            { label: "Uptime",  value: agent.uptime,        icon: Clock        },
            { label: "Tokens",  value: agent.tokens,        icon: RefreshCw    },
          ].map(({ label, value, icon: Icon }) => (
            <div key={label} className="flex items-center gap-2">
              <div className="w-6 h-6 rounded-md bg-muted flex items-center justify-center shrink-0">
                <Icon className="w-3 h-3 text-muted-foreground" />
              </div>
              <div className="min-w-0">
                <div className="text-xs font-bold text-foreground">{value}</div>
                <div className="text-[10px] text-muted-foreground">{label}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="border-t border-border/60 bg-muted/20 px-5 py-2.5 flex justify-between items-center">
        <span className="text-[11px] text-muted-foreground">Active {agent.lastActive}</span>
        <button className="text-[11px] font-semibold text-foreground hover:text-muted-foreground transition-colors">View traces →</button>
      </div>
    </div>
  );
}

export default function AgentsPage() {
  const [loading, setLoading] = useState(true);
  const [agents, setAgents]   = useState<Agent[]>([]);
  const [filter, setFilter]   = useState<"ALL" | "RUNNING" | "IDLE" | "ERROR">("ALL");
  const [search, setSearch]   = useState("");

  useEffect(() => { const t = setTimeout(() => { setAgents(DEMO_AGENTS); setLoading(false); }, 1000); return () => clearTimeout(t); }, []);

  if (loading) return <LoadingScreen message="Loading agents..." />;

  const filtered = agents
    .filter((a) => filter === "ALL" || a.status === filter)
    .filter((a) => !search || a.name.toLowerCase().includes(search.toLowerCase()) || a.id.includes(search));

  const counts = {
    RUNNING: agents.filter((a) => a.status === "RUNNING").length,
    IDLE:    agents.filter((a) => a.status === "IDLE").length,
    ERROR:   agents.filter((a) => a.status === "ERROR").length,
  };

  return (
    <>
      <PageHeader
        title="Agents"
        description="Registered swarm agents and their health"
        liveStatus="live"
        actions={
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search agents…"
              className="h-8 rounded-lg border border-border bg-card pl-8 pr-3 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring shadow-sm" />
          </div>
        }
      />

      <div className="p-6 space-y-6">
        <div className="grid grid-cols-4 gap-4">
          {[
            { label: "Total",   value: agents.length  },
            { label: "Running", value: counts.RUNNING },
            { label: "Idle",    value: counts.IDLE    },
            { label: "Error",   value: counts.ERROR   },
          ].map((s) => (
            <div key={s.label} className="rounded-xl border border-border bg-card p-4 shadow-sm">
              <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1 font-medium">{s.label}</div>
              <div className="text-2xl font-bold tabular-nums text-foreground">{s.value}</div>
            </div>
          ))}
        </div>

        <div className="flex gap-2">
          {(["ALL", "RUNNING", "IDLE", "ERROR"] as const).map((f) => (
            <button key={f} onClick={() => setFilter(f)}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-all ${
                filter === f ? "bg-primary text-white shadow-sm" : "border border-border bg-card text-muted-foreground hover:text-foreground hover:bg-muted/60 shadow-sm"
              }`}>
              {f}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
          {filtered.map((a) => <AgentCard key={a.id} agent={a} />)}
        </div>

        {filtered.length === 0 && (
          <div className="rounded-xl border border-border bg-card py-16 text-center text-sm text-muted-foreground shadow-sm">No agents match your filters.</div>
        )}
      </div>
    </>
  );
}
