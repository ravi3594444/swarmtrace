import { createFileRoute } from "@tanstack/react-router";
import { useState, useMemo } from "react";
import { SwarmLayout, LiveToggle } from "@/components/swarm/Layout";
import { DetailDrawer } from "@/components/swarm/DetailDrawer";
import { SmartJson } from "@/components/swarm/SmartJson";
import { CallChainCrumbs } from "@/components/swarm/CallChainCrumbs";
import { useLiveTraces } from "@/hooks/use-live-traces";
import type { Trace } from "@/lib/traces-data";

export const Route = createFileRoute("/traces")({
  head: () => ({
    meta: [
      { title: "SwarmTrace — Traces" },
      {
        name: "description",
        content: "Hierarchical span tree with full detail inspection.",
      },
      { property: "og:title", content: "SwarmTrace — Traces" },
    ],
  }),
  component: TracesRoute,
});

// ---------------------------------------------------------------------------
// Tree builder
// ---------------------------------------------------------------------------

type SpanNode = Trace & { children: SpanNode[] };

function buildTree(traces: Trace[]): SpanNode[] {
  const map = new Map<string, SpanNode>();
  traces.forEach((t) => map.set(t.id, { ...t, children: [] }));

  const roots: SpanNode[] = [];
  map.forEach((n) => {
    if (n.parent_id && map.has(n.parent_id)) {
      map.get(n.parent_id)!.children.push(n);
    } else {
      roots.push(n);
    }
  });

  map.forEach((n) =>
    n.children.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
  );
  roots.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return roots;
}

function countDesc(n: SpanNode): number {
  return n.children.reduce((s, c) => s + 1 + countDesc(c), 0);
}

function treeHasError(n: SpanNode): boolean {
  return !!n.error || n.children.some(treeHasError);
}

// ---------------------------------------------------------------------------
// SpanRow — recursive tree row
// ---------------------------------------------------------------------------

function SpanRow({
  node,
  depth,
  selected,
  onSelect,
  maxLatency,
}: {
  node: SpanNode;
  depth: number;
  selected: Trace | null;
  onSelect: (t: Trace) => void;
  maxLatency: number;
}) {
  const [expanded, setExpanded] = useState(depth === 0);

  const isRoot = depth === 0;
  const hasErr = isRoot ? treeHasError(node) : !!node.error;
  const isSelected = selected?.id === node.id;
  const hasChildren = node.children.length > 0;
  const descCount = isRoot ? countDesc(node) : 0;
  const pct = Math.max(2, (node.latency_sec / Math.max(maxLatency, 0.001)) * 100);
  const lat =
    node.latency_sec >= 1
      ? `${node.latency_sec.toFixed(2)}s`
      : `${Math.round(node.latency_sec * 1000)}ms`;

  return (
    <div className={isRoot ? "border-b border-border" : ""}>
      <div
        onClick={() => onSelect(node)}
        className={[
          "flex items-center gap-2 pr-4 cursor-pointer transition-colors border-l-2",
          isRoot ? "py-2.5" : "py-1.5",
          isSelected
            ? "bg-primary/[0.06] border-l-primary"
            : "hover:bg-muted/40 border-l-transparent",
        ].join(" ")}
        style={{ paddingLeft: `${depth * 18 + 12}px` }}
      >
        {/* Expand toggle */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            if (hasChildren) setExpanded((v) => !v);
          }}
          className={[
            "w-4 h-4 flex items-center justify-center shrink-0 rounded",
            hasChildren
              ? "text-muted-foreground hover:text-foreground"
              : "pointer-events-none cursor-default",
          ].join(" ")}
        >
          {hasChildren ? (
            expanded ? (
              <ChevronDown />
            ) : (
              <ChevronRight />
            )
          ) : (
            <span className="w-1 h-1 block rounded-full bg-muted-foreground/25" />
          )}
        </button>

        {/* Status dot */}
        <span
          className={`w-1.5 h-1.5 rounded-full shrink-0 ${
            hasErr ? "bg-destructive" : "bg-[oklch(0.7_0.18_145)]"
          }`}
        />

        {/* Function name */}
        <span
          className={[
            "font-mono text-xs truncate min-w-0 flex-1",
            isRoot ? "font-bold" : "font-medium",
            hasErr ? "text-destructive" : "text-foreground",
          ].join(" ")}
        >
          {node.function}
        </span>

        {/* Child count (root only) */}
        {isRoot && descCount > 0 && (
          <span className="font-mono text-[10px] text-muted-foreground/50 shrink-0 hidden sm:block">
            +{descCount}
          </span>
        )}

        {/* Span ID */}
        <span className="font-mono text-[10px] text-muted-foreground/35 shrink-0 w-16 text-right hidden md:block">
          {node.id.slice(0, 8)}
        </span>

        {/* Mini latency bar */}
        <div className="relative h-1 w-14 shrink-0 rounded-full bg-muted overflow-hidden hidden lg:block">
          <div
            className={`absolute left-0 top-0 h-full rounded-full ${
              hasErr ? "bg-destructive/40" : "bg-primary/40"
            }`}
            style={{ width: `${pct}%` }}
          />
        </div>

        {/* Latency */}
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground shrink-0 w-14 text-right">
          {lat}
        </span>

        {/* Tokens */}
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground shrink-0 w-14 text-right hidden lg:block">
          {(node.input_tokens + node.output_tokens).toLocaleString()}
        </span>

        {/* Cost */}
        <span className="font-mono text-[11px] tabular-nums text-foreground font-bold shrink-0 w-16 text-right">
          ${node.cost_usd.toFixed(4)}
        </span>

        {/* Status badge */}
        <span
          className={[
            "font-mono text-[9px] font-bold uppercase rounded-sm px-1.5 py-0.5 border shrink-0",
            hasErr
              ? "bg-destructive/10 text-destructive border-destructive/30"
              : "bg-[oklch(0.7_0.18_145)]/10 text-[oklch(0.55_0.18_145)] border-[oklch(0.7_0.18_145)]/30",
          ].join(" ")}
        >
          {hasErr ? "FAIL" : "OK"}
        </span>
      </div>

      {expanded &&
        hasChildren &&
        node.children.map((c) => (
          <SpanRow
            key={c.id}
            node={c}
            depth={depth + 1}
            selected={selected}
            onSelect={onSelect}
            maxLatency={maxLatency}
          />
        ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline span detail panel
// ---------------------------------------------------------------------------

function SpanDetail({
  trace,
  allTraces,
  onJump,
  onClose,
}: {
  trace: Trace;
  allTraces: Trace[];
  onJump: (t: Trace) => void;
  onClose: () => void;
}) {
  const ok = !trace.error;
  return (
    <div className="border border-border bg-card overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border bg-muted/30 px-4 py-3">
        <div className="min-w-0">
          <p
            className={`font-mono text-sm font-bold truncate ${
              ok ? "text-foreground" : "text-destructive"
            }`}
          >
            {trace.function}
          </p>
          <p className="font-mono text-[10px] text-muted-foreground mt-0.5">
            {trace.id}
          </p>
        </div>
        <button
          onClick={onClose}
          className="ml-3 shrink-0 rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          aria-label="Close"
        >
          <CloseIcon />
        </button>
      </div>

      <div className="p-4 space-y-4 overflow-y-auto max-h-[60vh]">
        {/* Error */}
        {!ok && (
          <div className="border-l-2 border-destructive bg-destructive/5 px-3 py-2">
            <p className="font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-destructive mb-1">
              Error
            </p>
            <pre className="font-mono text-xs text-destructive break-all whitespace-pre-wrap">
              {trace.error}
            </pre>
          </div>
        )}

        {/* Metrics row */}
        <div className="grid grid-cols-3 gap-2">
          {[
            [
              "Latency",
              trace.latency_sec >= 1
                ? `${trace.latency_sec.toFixed(3)}s`
                : `${Math.round(trace.latency_sec * 1000)}ms`,
            ],
            [
              "Tokens",
              (trace.input_tokens + trace.output_tokens).toLocaleString(),
            ],
            ["Cost", `$${trace.cost_usd.toFixed(5)}`],
          ].map(([label, value]) => (
            <div
              key={label}
              className="border border-border bg-muted/20 px-3 py-2 text-center"
            >
              <p className="font-mono text-base font-bold tabular-nums text-foreground">
                {value}
              </p>
              <p className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider mt-0.5">
                {label}
              </p>
            </div>
          ))}
        </div>

        {/* Call chain */}
        <div>
          <p className="font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground mb-1.5">
            Call Chain
          </p>
          <CallChainCrumbs
            trace={trace}
            allTraces={allTraces}
            onJump={onJump}
          />
        </div>

        {/* Input */}
        <div>
          <p className="font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground mb-1.5">
            Input
          </p>
          <SmartJson raw={trace.args} maxHeight="160px" />
        </div>

        {/* Output */}
        <div>
          <p className="font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground mb-1.5">
            Output
          </p>
          <SmartJson raw={trace.output} maxHeight="160px" />
        </div>

        {/* Details table */}
        <div>
          <p className="font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground mb-1.5">
            Details
          </p>
          <div className="border border-border divide-y divide-border/60 overflow-hidden">
            {(
              [
                ["Span ID", trace.id],
                ["Parent ID", trace.parent_id ?? "(root)"],
                ["Timestamp", new Date(trace.timestamp).toLocaleString()],
                ["Input tokens", trace.input_tokens.toLocaleString()],
                ["Output tokens", trace.output_tokens.toLocaleString()],
                [
                  "Total tokens",
                  (trace.input_tokens + trace.output_tokens).toLocaleString(),
                ],
                ["Cost (USD)", `$${trace.cost_usd.toFixed(6)}`],
              ] as [string, string][]
            ).map(([k, v]) => (
              <div key={k} className="flex gap-4 px-3 py-2">
                <span className="font-mono text-[10px] text-muted-foreground w-28 shrink-0">
                  {k}
                </span>
                <span className="font-mono text-[10px] text-foreground break-all">
                  {v}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function TracesRoute() {
  const [live, setLive] = useState(false);
  const { traces, newIds, lastPoll, error } = useLiveTraces(live);
  const [selected, setSelected] = useState<Trace | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"ALL" | "OK" | "FAIL">(
    "ALL"
  );

  const filtered = useMemo(() => {
    return traces.filter((t) => {
      if (statusFilter === "OK" && t.error) return false;
      if (statusFilter === "FAIL" && !t.error) return false;
      if (search) {
        const q = search.toLowerCase();
        return (
          t.function.toLowerCase().includes(q) ||
          t.id.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [traces, search, statusFilter]);

  const roots = useMemo(() => buildTree(filtered), [filtered]);
  const maxLatency = useMemo(
    () => Math.max(...filtered.map((t) => t.latency_sec), 0.001),
    [filtered]
  );

  const errorCount = filtered.filter((t) => t.error).length;

  return (
    <SwarmLayout
      rightSlot={
        <LiveToggle enabled={live} onToggle={setLive} lastPoll={lastPoll} />
      }
    >
      <div className="space-y-6">
        {/* Page header */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">
              Traces
              <span className="mx-3 text-border">/</span>
              <span className="font-mono text-sm text-primary">
                {filtered.length} spans
              </span>
              {errorCount > 0 && (
                <span className="ml-2 font-mono text-sm text-destructive">
                  · {errorCount} errors
                </span>
              )}
            </h1>
            <p className="mt-1 text-xs text-muted-foreground">
              Hierarchical span tree — expand roots to inspect child calls
            </p>
          </div>

          {/* Filters */}
          <div className="flex items-center gap-2 shrink-0">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search…"
              className="h-7 rounded-sm border border-border bg-card px-2.5 font-mono text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary w-36"
            />
            {(["ALL", "OK", "FAIL"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setStatusFilter(f)}
                className={[
                  "h-7 rounded-sm px-2.5 font-mono text-[10px] font-bold uppercase tracking-wider transition",
                  statusFilter === f
                    ? "bg-primary text-white"
                    : "border border-border text-muted-foreground hover:text-foreground",
                ].join(" ")}
              >
                {f}
              </button>
            ))}
          </div>
        </div>

        {/* API error banner */}
        {error && live && (
          <div className="flex items-center gap-2 border border-destructive/30 bg-destructive/10 px-4 py-3 font-mono text-xs text-destructive">
            <span className="text-[10px] font-bold uppercase tracking-[0.16em]">
              ⚠
            </span>
            <span>API unavailable — showing demo data</span>
          </div>
        )}

        {/* Span tree */}
        <div className="border border-border bg-card overflow-hidden">
          {/* Column headers */}
          <div className="flex items-center gap-2 border-b border-border bg-muted/20 px-3 py-2 font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
            <div className="w-4 shrink-0" />
            <div className="w-1.5 shrink-0" />
            <div className="flex-1">Span / Function</div>
            <div className="w-16 text-right hidden md:block">ID</div>
            <div className="w-14 hidden lg:block" />
            <div className="w-14 text-right">Latency</div>
            <div className="w-14 text-right hidden lg:block">Tokens</div>
            <div className="w-16 text-right">Cost</div>
            <div className="w-10 shrink-0" />
          </div>

          {roots.length === 0 ? (
            <div className="py-16 text-center font-mono text-xs text-muted-foreground">
              {traces.length === 0
                ? "No spans captured yet — enable Live to start polling."
                : "No spans match your filters."}
            </div>
          ) : (
            roots.map((root) => (
              <SpanRow
                key={root.id}
                node={root}
                depth={0}
                selected={selected}
                onSelect={setSelected}
                maxLatency={maxLatency}
              />
            ))
          )}
        </div>

        {/* Inline detail panel */}
        {selected && (
          <SpanDetail
            trace={selected}
            allTraces={traces}
            onJump={setSelected}
            onClose={() => setSelected(null)}
          />
        )}
      </div>

      {/* Drawer (mobile / overlay fallback) */}
      <DetailDrawer
        trace={null}
        allTraces={traces}
        onClose={() => {}}
        onJump={setSelected}
      />
    </SwarmLayout>
  );
}

// ---------------------------------------------------------------------------
// Tiny inline SVG icons (no lucide dep in this project)
// ---------------------------------------------------------------------------

function ChevronRight() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      className="w-3 h-3"
    >
      <path d="M9 18l6-6-6-6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ChevronDown() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      className="w-3 h-3"
    >
      <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className="w-4 h-4"
    >
      <path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" />
    </svg>
  );
}
