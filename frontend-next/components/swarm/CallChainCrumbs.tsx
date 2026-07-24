'use client'

import type { Trace } from "@/lib/trace-types";
import { buildCallChain } from "@/lib/trace-utils";

export function CallChainCrumbs({
  trace,
  allTraces,
  onJump,
  variant = "muted",
}: {
  trace: Trace;
  allTraces: Trace[];
  onJump: (t: Trace) => void;
  variant?: "muted" | "danger";
}) {
  const chain  = buildCallChain(trace, allTraces);
  const isLast = (i: number) => i === chain.length - 1;

  return (
    <div className="flex flex-wrap items-center gap-1 text-xs">
      {chain.map((c, i) => (
        <span key={c.id} className="flex items-center gap-1">
          <button
            onClick={() => !isLast(i) && onJump(c)}
            disabled={isLast(i)}
            className={`rounded-md px-1.5 py-0.5 font-mono transition-colors border ${
              isLast(i)
                ? variant === "danger"
                  ? "bg-red-50 dark:bg-red-950/30 text-destructive border-red-200 dark:border-red-900/60"
                  : "bg-muted text-foreground border-border"
                : "bg-muted text-muted-foreground border-border hover:bg-muted/60 hover:text-foreground"
            }`}
          >
            {c.function}
          </button>
          {!isLast(i) && <span className="text-muted-foreground/50">→</span>}
        </span>
      ))}
    </div>
  );
}