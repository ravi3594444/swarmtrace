import { useState, useMemo } from "react";
import { useTraces } from "@/hooks/use-traces";
import { SmartJson } from "@/components/swarm/SmartJson";
import { CallChainCrumbs } from "@/components/swarm/CallChainCrumbs";
import { LoadingScreen } from "@/components/LoadingScreen";
import { PageHeader } from "@/components/Layout";
import type { Trace } from "@/lib/traces-data";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import {
  ChevronRight, ChevronDown, X, Clock, Activity, Coins,
  AlertTriangle, Search, Pause, Play, Database,
} from "lucide-react";

// ─── Tree ────────────────────────────────────────────────────────────────────

type SpanNode = Trace & { children: SpanNode[] };

function buildTree(traces: Trace[]): SpanNode[] {
  const map = new Map<string, SpanNode>();
  traces.forEach(t => map.set(t.id, { ...t, children: [] }));
  const roots: SpanNode[] = [];
  map.forEach(n => {
    if (n.parent_id && map.has(n.parent_id)) map.get(n.parent_id)!.children.push(n);
    else roots.push(n);
  });
  map.forEach(n => n.children.sort((a, b) => a.timestamp.localeCompare(b.timestamp)));
  roots.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return roots;
}

function countDesc(n: SpanNode): number {
  return n.children.reduce((s, c) => s + 1 + countDesc(c), 0);
}
function treeErr(n: SpanNode): boolean {
  return !!n.error || n.children.some(treeErr);
}

// ─── Detail panel ────────────────────────────────────────────────────────────

function TraceDetail({ trace, allTraces, onClose, onJump }: {
  trace: Trace; allTraces: Trace[]; onClose: () => void; onJump: (t: Trace) => void;
}) {
  const ok = !trace.error;
  return (
    <div className="h-full flex flex-col overflow-hidden border-l border-border bg-card">
      <div className="flex items-center justify-between border-b border-border bg-muted/30 px-4 py-3 shrink-0">
        <div className="min-w-0">
          <div className={`text-sm font-semibold truncate ${ok ? "text-foreground" : "text-destructive"}`}>
            {trace.function}
          </div>
          <div className="font-mono text-[10px] text-muted-foreground mt-0.5">{trace.id}</div>
        </div>
        <button onClick={onClose} className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors shrink-0 ml-2">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {!ok && (
          <div className="rounded-xl border border-red-200 bg-red-50 p-3">
            <div className="flex items-center gap-2 mb-2">
              <AlertTriangle className="w-3.5 h-3.5 text-destructive" />
              <span className="text-xs font-semibold text-destructive">Error</span>
            </div>
            <pre className="font-mono text-xs text-destructive break-all whitespace-pre-wrap">{trace.error}</pre>
          </div>
        )}

        <div className="grid grid-cols-3 gap-2">
          {[
            { label: "Latency", value: `${trace.latency_sec.toFixed(3)}s`, icon: Clock },
            { label: "Tokens",  value: (trace.input_tokens + trace.output_tokens).toLocaleString(), icon: Activity },
            { label: "Cost",    value: `$${trace.cost_usd.toFixed(5)}`, icon: Coins },
          ].map(({ label, value, icon: Icon }) => (
            <div key={label} className="rounded-xl border border-border bg-muted/30 p-2.5 text-center">
              <Icon className="w-3 h-3 text-muted-foreground mx-auto mb-1" />
              <div className="font-mono text-xs font-bold text-foreground">{value}</div>
              <div className="text-[10px] text-muted-foreground">{label}</div>
            </div>
          ))}
        </div>

        <div>
          <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-1.5">Status</div>
          <span className={`inline-block rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase border ${ok ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-red-50 text-red-700 border-red-200"}`}>
            {ok ? "SUCCESS" : "ERROR"}
          </span>
        </div>

        <div>
          <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-1.5">Call Chain</div>
          <CallChainCrumbs trace={trace} allTraces={allTraces} onJump={onJump} />
        </div>

        <div>
          <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-1.5">Input</div>
          <SmartJson raw={trace.args} maxHeight="180px" />
        </div>

        <div>
          <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-1.5">Output</div>
          <SmartJson raw={trace.output} maxHeight="200px" />
        </div>

        <div>
          <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-1.5">Details</div>
          <div className="rounded-xl border border-border bg-muted/20 overflow-hidden">
            {([
              ["Span ID",       trace.id],
              ["Parent ID",     trace.parent_id ?? "(root span)"],
              ["Timestamp",     new Date(trace.timestamp).toLocaleString()],
              ["Input tokens",  trace.input_tokens.toLocaleString()],
              ["Output tokens", trace.output_tokens.toLocaleString()],
              ["Total tokens",  (trace.input_tokens + trace.output_tokens).toLocaleString()],
              ["Cost (USD)",    `$${trace.cost_usd.toFixed(6)}`],
            ] as [string, string][]).map(([k, v]) => (
              <div key={k} className="flex items-start justify-between gap-4 px-3 py-2 border-b border-border/40 last:border-0">
                <span className="text-xs text-muted-foreground shrink-0">{k}</span>
                <span className="text-xs font-mono text-foreground text-right break-all">{v}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Span row ─────────────────────────────────────────────────────────────────

function SpanRow({ node, depth, selected, onSelect, maxLatency }: {
  node: SpanNode; depth: number; selected: Trace | null;
  onSelect: (t: Trace) => void; maxLatency: number;
}) {
  const [expanded, setExpanded] = useState(depth === 0);
  const isRoot = depth === 0;
  const hasErr = isRoot ? treeErr(node) : !!node.error;
  const isSelected = selected?.id === node.id;
  const hasKids = node.children.length > 0;
  const descCount = isRoot ? countDesc(node) : 0;
  const pct = Math.max(3, (node.latency_sec / Math.max(maxLatency, 0.001)) * 100);
  const lat = node.latency_sec >= 1 ? `${node.latency_sec.toFixed(2)}s` : `${Math.round(node.latency_sec * 1000)}ms`;

  return (
    <div className={isRoot ? "border-b border-border" : ""}>
      <div
        onClick={() => onSelect(node)}
        className={[
          "flex items-center gap-2 pr-4 cursor-pointer transition-colors border-l-2",
          isRoot ? "py-2.5" : "py-1.5",
          isSelected ? "bg-primary/[0.06] border-l-primary" : "hover:bg-muted/40 border-l-transparent",
        ].join(" ")}
        style={{ paddingLeft: `${depth * 18 + 12}px` }}
      >
        <button
          onClick={e => { e.stopPropagation(); if (hasKids) setExpanded(v => !v); }}
          className={`w-4 h-4 flex items-center justify-center shrink-0 rounded ${hasKids ? "text-muted-foreground hover:text-foreground" : "pointer-events-none"}`}
        >
          {hasKids
            ? expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />
            : <span className="w-1 h-1 block rounded-full bg-muted-foreground/20" />}
        </button>

        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${hasErr ? "bg-red-400" : "bg-emerald-500"}`} />

        <span className={["text-xs truncate min-w-0 flex-1", isRoot ? "font-semibold" : "font-medium", hasErr ? "text-destructive" : "text-foreground"].join(" ")}>
          {node.function}
        </span>

        {isRoot && descCount > 0 && (
          <span className="font-mono text-[10px] text-muted-foreground/50 shrink-0 hidden lg:block">+{descCount}</span>
        )}

        <span className="font-mono text-[10px] text-muted-foreground/35 shrink-0 w-16 text-right hidden lg:block truncate">
          {node.id.slice(0, 8)}
        </span>

        <div className="relative h-1 w-14 shrink-0 rounded-full bg-muted overflow-hidden hidden xl:block">
          <div className={`absolute left-0 top-0 h-full rounded-full ${hasErr ? "bg-red-300" : "bg-primary/40"}`} style={{ width: `${pct}%` }} />
        </div>

        <span className="font-mono text-[11px] tabular-nums text-muted-foreground shrink-0 w-14 text-right">{lat}</span>
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground shrink-0 w-14 text-right hidden xl:block">
          {(node.input_tokens + node.output_tokens).toLocaleString()}
        </span>
        <span className="font-mono text-[11px] tabular-nums text-foreground font-semibold shrink-0 w-16 text-right">
          ${node.cost_usd.toFixed(4)}
        </span>

        <span className={`text-[9px] font-bold uppercase rounded-full px-1.5 py-0.5 border shrink-0 ${hasErr ? "bg-red-50 text-red-700 border-red-200" : "bg-emerald-50 text-emerald-700 border-emerald-200"}`}>
          {hasErr ? "ERR" : "OK"}
        </span>
      </div>

      {expanded && hasKids && node.children.map(c => (
        <SpanRow key={c.id} node={c} depth={depth + 1} selected={selected} onSelect={onSelect} maxLatency={maxLatency} />
      ))}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function TracesPage() {
  const { traces, loading, source, isLive, toggleLive } = useTraces(8000);
  const [selected, setSelected] = useState<Trace | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"ALL" | "OK" | "ERROR">("ALL");

  const filtered = useMemo(() => traces.filter(t => {
    if (statusFilter === "OK" && t.error) return false;
    if (statusFilter === "ERROR" && !t.error) return false;
    if (search) {
      const q = search.toLowerCase();
      return t.function.toLowerCase().includes(q) || t.id.toLowerCase().includes(q);
    }
    return true;
  }), [traces, search, statusFilter]);

  const roots = useMemo(() => buildTree(filtered), [filtered]);
  const maxLatency = useMemo(() => Math.max(...filtered.map(t => t.latency_sec), 0.001), [filtered]);

  if (loading) return <LoadingScreen message="Fetching traces…" />;

  const errorCount = filtered.filter(t => t.error).length;

  return (
    <>
      <PageHeader
        title="Traces"
        description="Span tree — click any row to inspect"
        liveStatus={isLive ? "live" : "paused"}
        actions={
          <div className="flex items-center gap-2">
            {source === "demo" && (
              <span className="flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[10px] font-semibold text-amber-700">
                <Database className="w-3 h-3" /> DEMO
              </span>
            )}
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
              <input
                type="text" placeholder="Search spans…" value={search}
                onChange={e => setSearch(e.target.value)}
                className="h-8 rounded-lg border border-border bg-card pl-8 pr-3 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring shadow-sm w-44"
              />
            </div>
            {(["ALL", "OK", "ERROR"] as const).map(f => (
              <button key={f} onClick={() => setStatusFilter(f)}
                className={`h-8 rounded-lg px-3 text-xs font-medium shadow-sm transition-all ${statusFilter === f ? "bg-primary text-white" : "border border-border bg-card text-muted-foreground hover:text-foreground"}`}>
                {f}
              </button>
            ))}
            <button onClick={toggleLive}
              className="flex items-center gap-1.5 h-8 rounded-lg border border-border bg-card px-3 text-xs text-muted-foreground hover:text-foreground transition-colors shadow-sm">
              {isLive ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />}
              {isLive ? "Pause" : "Resume"}
            </button>
          </div>
        }
      />

      <div className="h-[calc(100vh-64px)]">
        <PanelGroup direction="horizontal" className="h-full">
          <Panel defaultSize={selected ? 58 : 100} minSize={38}>
            <div className="h-full flex flex-col overflow-hidden">
              {/* Sub-header */}
              <div className="flex items-center justify-between border-b border-border bg-card px-4 py-2 shrink-0">
                <span className="text-xs text-muted-foreground">
                  <span className="font-semibold text-foreground tabular-nums">{filtered.length}</span> spans
                  {errorCount > 0 && <span className="ml-2 text-red-600 font-medium">· {errorCount} error{errorCount > 1 ? "s" : ""}</span>}
                  {filtered.length !== traces.length && <span className="ml-1 text-muted-foreground/60">(of {traces.length})</span>}
                </span>
              </div>

              {/* Column headers */}
              <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-muted/20 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground shrink-0">
                <div className="w-4 shrink-0" />
                <div className="w-1.5 shrink-0" />
                <div className="flex-1">Span / Function</div>
                <div className="w-16 text-right hidden lg:block">ID</div>
                <div className="w-14 hidden xl:block" />
                <div className="w-14 text-right">Latency</div>
                <div className="w-14 text-right hidden xl:block">Tokens</div>
                <div className="w-16 text-right">Cost</div>
                <div className="w-10 shrink-0" />
              </div>

              {/* Scrollable tree */}
              <div className="flex-1 overflow-y-auto">
                {roots.length === 0 ? (
                  <div className="flex items-center justify-center py-24 text-sm text-muted-foreground">
                    {traces.length === 0 ? "No spans yet." : "No spans match your filters."}
                  </div>
                ) : (
                  roots.map(root => (
                    <SpanRow key={root.id} node={root} depth={0} selected={selected} onSelect={setSelected} maxLatency={maxLatency} />
                  ))
                )}
              </div>
            </div>
          </Panel>

          {selected && (
            <>
              <PanelResizeHandle className="w-1 bg-border hover:bg-primary/40 transition-colors cursor-col-resize" />
              <Panel defaultSize={42} minSize={28} maxSize={65}>
                <TraceDetail trace={selected} allTraces={traces} onClose={() => setSelected(null)} onJump={setSelected} />
              </Panel>
            </>
          )}
        </PanelGroup>
      </div>
    </>
  );
}
