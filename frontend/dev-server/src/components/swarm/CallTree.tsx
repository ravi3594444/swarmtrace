import type { Trace } from "@/lib/traces-data";

type Node = Trace & { children: Node[] };

function buildTree(traces: Trace[]): Node[] {
  const ids = new Set(traces.map((t) => t.id));
  const map = new Map<string, Node>();
  traces.forEach((t) => map.set(t.id, { ...t, children: [] }));
  const roots: Node[] = [];
  map.forEach((n) => {
    if (n.parent_id && ids.has(n.parent_id)) {
      map.get(n.parent_id)!.children.push(n);
    } else {
      roots.push(n);
    }
  });
  return roots;
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
  const widthPct = Math.max(2, (node.latency_sec / maxLatency) * 100);

  return (
    <div>
      <button
        onClick={() => onSelect(node)}
        className="group flex w-full items-center gap-3 px-3 py-2 text-left font-mono text-xs transition hover:bg-muted/40"
        style={{ paddingLeft: `${depth * 20 + 12}px` }}
      >
        <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
          <span className={`h-3.5 w-3.5 rounded-full ${ok ? "bg-primary/20" : "bg-destructive/20"} flex items-center justify-center`}>
            <span className={`h-1.5 w-1.5 rounded-full ${ok ? "bg-primary" : "bg-destructive"}`} />
          </span>
        </span>
        <span className={`shrink-0 ${ok ? "text-foreground" : "text-destructive"}`}>
          {node.function}
        </span>
        <span className="flex-1 border-b border-dotted border-border" />
        <span className="shrink-0 text-[10px] text-muted-foreground/60">{node.id}</span>
        <div className="relative h-1.5 w-32 shrink-0 bg-muted">
          <div
            className={`absolute left-0 top-0 h-full ${ok ? "bg-primary/60" : "bg-destructive/60"}`}
            style={{ width: `${widthPct}%` }}
          />
        </div>
        <span className="w-12 shrink-0 text-right tabular-nums text-muted-foreground">
          {node.latency_sec.toFixed(2)}s
        </span>
        <span
          className={`shrink-0 border px-1 text-[9px] ${
            ok
              ? "border-[oklch(0.7_0.18_145)]/30 text-[oklch(0.7_0.18_145)]"
              : "border-destructive/30 text-destructive"
          }`}
        >
          {ok ? "OK" : "ERR"}
        </span>
      </button>
      {node.children.map((c) => (
        <TreeNode
          key={c.id}
          node={c}
          maxLatency={maxLatency}
          depth={depth + 1}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

export function CallTree({
  traces,
  onSelect,
}: {
  traces: Trace[];
  onSelect: (t: Trace) => void;
}) {
  const roots = buildTree(traces);
  const maxLatency = Math.max(...traces.map((t) => t.latency_sec), 0.001);

  return (
    <div className="overflow-hidden border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border bg-muted/30 px-4 py-2.5 font-mono text-[11px] uppercase tracking-[0.16em] font-bold text-muted-foreground">
        <span>Agent Call Tree</span>
        <span className="text-[10px] text-muted-foreground/60">EXECUTION_SEQUENCE.LOG</span>
      </div>
      <div className="py-2">
        {roots.map((r) => (
          <TreeNode key={r.id} node={r} maxLatency={maxLatency} depth={0} onSelect={onSelect} />
        ))}
      </div>
    </div>
  );
}
