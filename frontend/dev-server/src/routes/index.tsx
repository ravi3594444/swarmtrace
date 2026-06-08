import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import type { Trace } from "@/lib/traces-data";
import { LiveToggle, SwarmLayout } from "@/components/swarm/Layout";
import { StatBar } from "@/components/swarm/StatBar";
import { CallTree } from "@/components/swarm/CallTree";
import { TraceTable } from "@/components/swarm/TraceTable";
import { DetailDrawer } from "@/components/swarm/DetailDrawer";
import { Waterfall } from "@/components/swarm/Waterfall";
import { TokenChart } from "@/components/swarm/TokenChart";
import { useLiveTraces } from "@/hooks/use-live-traces";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "SwarmTrace — Dashboard" },
      { name: "description", content: "Visualise AI agent traces: call tree, waterfall, latency, tokens, cost, and errors." },
      { property: "og:title", content: "SwarmTrace — Dashboard" },
      { property: "og:description", content: "Visualise AI agent traces: call tree, waterfall, latency, tokens, cost, and errors." },
    ],
  }),
  component: Dashboard,
});

function Dashboard() {
  const [live, setLive] = useState(false);
  const { traces, newIds, lastPoll, error } = useLiveTraces(live);
  const [selected, setSelected] = useState<Trace | null>(null);
  const [view, setView] = useState<"tree" | "waterfall">("tree");

  return (
    <SwarmLayout
      rightSlot={<LiveToggle enabled={live} onToggle={setLive} lastPoll={lastPoll} />}
    >
      <div className="space-y-8">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Dashboard
            <span className="mx-3 text-border">/</span>
            <span className="font-mono text-sm text-primary">run_id: 84b4bd8a</span>
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {traces.length} traces captured in last session
          </p>
        </div>

        {error && live && (
          <div className="flex items-center gap-2 border border-destructive/30 bg-destructive/10 px-4 py-3 font-mono text-xs text-destructive">
            <span className="text-[10px] font-bold uppercase tracking-[0.16em]">⚠</span>
            <span>API unavailable — showing demo data</span>
          </div>
        )}

        <StatBar traces={traces} />
        <TokenChart traces={traces} />

        <div className="flex w-fit items-center gap-1 border border-border bg-card p-1">
          <TabBtn active={view === "tree"} onClick={() => setView("tree")}>Call Tree</TabBtn>
          <TabBtn active={view === "waterfall"} onClick={() => setView("waterfall")}>Waterfall</TabBtn>
        </div>

        {view === "tree" ? (
          <CallTree traces={traces} onSelect={setSelected} />
        ) : (
          <Waterfall traces={traces} onSelect={setSelected} />
        )}

        <TraceTable traces={traces} onSelect={setSelected} newIds={newIds} />
      </div>
      <DetailDrawer
        trace={selected}
        allTraces={traces}
        onClose={() => setSelected(null)}
        onJump={(t) => setSelected(t)}
      />
    </SwarmLayout>
  );
}

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-1 font-mono text-[11px] font-bold uppercase tracking-wider transition ${
        active ? "border border-border bg-muted text-primary" : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}
