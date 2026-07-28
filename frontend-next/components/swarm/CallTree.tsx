'use client'

import { useState, useCallback } from "react";
import type { Trace } from "@/lib/trace-types";
import { buildSpanTree, type SpanNode as Node } from "@/lib/span-tree";
import { ChevronRight, ChevronDown, Copy, Check, ChevronsDownUp, ChevronsUpDown } from "lucide-react";

function truncateId(id: string): string {
  return id.length <= 10 ? id : `${id.slice(0, 4)}...${id.slice(-4)}`;
}

function CopyId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async (e) => {
        e.stopPropagation();
        // Wrap in try/catch — clipboard API rejects in non-secure contexts
        // (HTTP non-localhost) or on permission denial. Without this, the
        // unhandled rejection is logged and setCopied never runs.
        try {
          await navigator.clipboard.writeText(id);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch {
          // Silently ignore — the id text is visible for manual copy.
        }
      }}
      title={copied ? "Copied!" : `Copy ${id}`}
      aria-label={copied ? "Copied" : `Copy trace ID ${id}`}
      className="shrink-0 flex items-center gap-1 rounded px-1 py-0.5 -mx-1 text-muted-foreground/70 hover:text-foreground hover:bg-muted transition-colors"
    >
      <span className="font-mono text-[10px]">{truncateId(id)}</span>
      {copied ? <Check className="w-2.5 h-2.5 text-emerald-600 dark:text-emerald-400" /> : <Copy className="w-2.5 h-2.5" />}
    </button>
  );
}

function TreeNode({
  node,
  maxLatency,
  depth,
  onSelect,
  collapsed,
  onToggleCollapse,
}: {
  node: Node;
  maxLatency: number;
  depth: number;
  onSelect: (t: Trace) => void;
  collapsed: Set<string>;
  onToggleCollapse: (id: string) => void;
}) {
  const ok = !node.error;
  const widthPct = Math.max(3, (node.latency_sec / maxLatency) * 100);
  const hasChildren = node.children.length > 0;
  const isCollapsed = collapsed.has(node.id);

  return (
    <div>
      <button
        onClick={() => onSelect(node)}
        aria-label={`${node.function}, ${node.latency_sec.toFixed(2)} seconds, ${ok ? "ok" : "error"}. ${node.id}${hasChildren ? `. ${isCollapsed ? "Expand" : "Collapse"} children` : ""}`}
        className="group flex w-full items-center gap-3 px-4 py-2.5 text-left text-xs transition-all hover:bg-muted/60 border-b border-border/50 last:border-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2"
        style={{ paddingLeft: `${depth * 20 + 16}px` }}
      >
        {/* Collapse/expand toggle — only shown for nodes with children.
            Clicking it toggles children WITHOUT selecting the row (the
            outer button handles selection). stopPropagation prevents the
            row's onClick from also firing. */}
        {hasChildren ? (
          <span
            role="button"
            tabIndex={0}
            aria-label={isCollapsed ? "Expand children" : "Collapse children"}
            onClick={(e) => { e.stopPropagation(); onToggleCollapse(node.id); }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                onToggleCollapse(node.id);
              }
            }}
            className="shrink-0 flex items-center justify-center w-4 h-4 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer"
          >
            {isCollapsed ? <ChevronRight className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </span>
        ) : depth > 0 ? (
          <ChevronRight className="w-3 h-3 shrink-0 text-muted-foreground/40" />
        ) : (
          <span className="shrink-0 w-3 h-3" />
        )}
        <span className={`flex-none w-1.5 h-1.5 rounded-full shrink-0 ${ok ? "bg-emerald-500" : "bg-red-500"}`} />
        <span className={`shrink-0 font-mono font-medium ${ok ? "text-foreground" : "text-destructive"}`}>
          {node.function}
        </span>
        <span className="flex-1 border-b border-dotted border-border" />
        <CopyId id={node.id} />
        <div className="relative h-1.5 w-20 shrink-0 rounded-full bg-muted overflow-hidden">
          <div
            className={`absolute left-0 top-0 h-full rounded-full transition-all ${ok ? "bg-primary/60" : "bg-red-300"}`}
            style={{ width: `${widthPct}%` }}
          />
        </div>
        <span className="w-14 shrink-0 text-right tabular-nums text-muted-foreground font-mono">
          {node.latency_sec.toFixed(2)}s
        </span>
        <span className={`shrink-0 rounded-full px-2 py-0.5 font-mono text-[10px] font-bold uppercase ${
          ok ? "bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-900/60"
             : "bg-red-50 dark:bg-red-950/30 text-destructive border border-red-200 dark:border-red-900/60"
        }`}>
          {ok ? "OK" : "ERR"}
        </span>
      </button>
      {!isCollapsed && node.children.map((c) => (
        <TreeNode
          key={c.id}
          node={c}
          maxLatency={maxLatency}
          depth={depth + 1}
          onSelect={onSelect}
          collapsed={collapsed}
          onToggleCollapse={onToggleCollapse}
        />
      ))}
    </div>
  );
}

export function CallTree({ traces, onSelect }: { traces: Trace[]; onSelect: (t: Trace) => void }) {
  const roots = buildSpanTree(traces);
  const maxLatency = Math.max(...traces.map((t) => t.latency_sec), 0.001);

  // Collapsed node ids. Starts empty (all expanded). "Collapse all" fills
  // it with every non-leaf id; "Expand all" clears it. Individual toggles
  // add/remove a single id. Using a Set keeps lookups O(1) and avoids
  // re-renders of unrelated branches.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  const toggleCollapse = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const collapseAll = useCallback(() => {
    // Collapse every node that has children (leaves have nothing to hide).
    const ids = new Set<string>();
    const walk = (n: Node) => {
      if (n.children.length > 0) ids.add(n.id);
      n.children.forEach(walk);
    };
    roots.forEach(walk);
    setCollapsed(ids);
  }, [roots]);

  const expandAll = useCallback(() => setCollapsed(new Set()), []);

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="flex items-center justify-between border-b border-border bg-muted/40 px-4 py-3">
        <h3 className="text-sm font-semibold text-foreground">Agent Call Tree</h3>
        <div className="flex items-center gap-2">
          {/* Collapse/expand all — saves clicking when a swarm has many
              nested agents. The icons (ChevronsDownUp / ChevronsUpDown)
              match the convention used in IDEs and file explorers. */}
          <button
            onClick={collapseAll}
            title="Collapse all"
            aria-label="Collapse all branches"
            className="flex items-center justify-center w-7 h-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <ChevronsDownUp className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={expandAll}
            title="Expand all"
            aria-label="Expand all branches"
            className="flex items-center justify-center w-7 h-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <ChevronsUpDown className="w-3.5 h-3.5" />
          </button>
          <span className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider ml-1">execution sequence</span>
        </div>
      </div>
      <div>
        {roots.length === 0 ? (
          <div className="py-12 text-center text-sm text-muted-foreground">No traces to display</div>
        ) : (
          roots.map((r) => (
            <TreeNode
              key={r.id}
              node={r}
              maxLatency={maxLatency}
              depth={0}
              onSelect={onSelect}
              collapsed={collapsed}
              onToggleCollapse={toggleCollapse}
            />
          ))
        )}
      </div>
    </div>
  );
}
