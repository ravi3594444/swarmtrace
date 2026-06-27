'use client'

import { useState } from "react";
import type { Trace } from "@/lib/trace-types";
import { buildSpanTree, type SpanNode as Node } from "@/lib/span-tree";
import { ChevronRight, Copy, Check } from "lucide-react";

function truncateId(id: string): string {
  return id.length <= 10 ? id : `${id.slice(0, 4)}...${id.slice(-4)}`;
}

function CopyId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(id);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      title={copied ? "Copied!" : `Copy ${id}`}
      className="shrink-0 flex items-center gap-1 rounded px-1 py-0.5 -mx-1 text-muted-foreground/70 hover:text-foreground hover:bg-muted transition-colors"
    >
      <span className="font-mono text-[10px]">{truncateId(id)}</span>
      {copied ? <Check className="w-2.5 h-2.5 text-emerald-600" /> : <Copy className="w-2.5 h-2.5" />}
    </button>
  );
}

function TreeNode({
  node,
  maxLatency,
  depth,
  onSelect,
}: {
  node: Node;
  maxLatency: number;
  depth: number;
  onSelect: (t: Trace) => void;
}) {
  const ok = !node.error;
  const widthPct = Math.max(3, (node.latency_sec / maxLatency) * 100);

  return (
    <div>
      <button
        onClick={() => onSelect(node)}
        className="group flex w-full items-center gap-3 px-4 py-2.5 text-left text-xs transition-all hover:bg-muted/60 border-b border-border/50 last:border-0"
        style={{ paddingLeft: `${depth * 20 + 16}px` }}
      >
        {depth > 0 && (
          <ChevronRight className="w-3 h-3 shrink-0 text-muted-foreground/40" />
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
        <span className={`shrink-0 rounded-full px-2 py-0.5 font-mono text-[9px] font-bold uppercase ${
          ok ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
             : "bg-red-50 text-destructive border border-red-200"
        }`}>
          {ok ? "OK" : "ERR"}
        </span>
      </button>
      {node.children.map((c) => (
        <TreeNode key={c.id} node={c} maxLatency={maxLatency} depth={depth + 1} onSelect={onSelect} />
      ))}
    </div>
  );
}

export function CallTree({ traces, onSelect }: { traces: Trace[]; onSelect: (t: Trace) => void }) {
  const roots = buildSpanTree(traces);
  const maxLatency = Math.max(...traces.map((t) => t.latency_sec), 0.001);

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden shadow-sm">
      <div className="flex items-center justify-between border-b border-border bg-muted/40 px-4 py-3">
        <h3 className="text-sm font-semibold text-foreground">Agent Call Tree</h3>
        <span className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">execution sequence</span>
      </div>
      <div>
        {roots.length === 0 ? (
          <div className="py-12 text-center text-sm text-muted-foreground">No traces to display</div>
        ) : (
          roots.map((r) => (
            <TreeNode key={r.id} node={r} maxLatency={maxLatency} depth={0} onSelect={onSelect} />
          ))
        )}
      </div>
    </div>
  );
}
