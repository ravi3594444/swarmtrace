import type { Trace } from "@/lib/traces-data";
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
  const chain = buildCallChain(trace, allTraces);
  const isLast = (i: number) => i === chain.length - 1;
  const lastClass =
    variant === "danger"
      ? "bg-destructive/20 text-destructive"
      : "bg-muted/80 text-foreground";

  return (
    <div className="flex flex-wrap items-center gap-1 text-xs">
      {chain.map((c, i) => (
        <span key={c.id} className="flex items-center gap-1">
          <button
            onClick={() => !isLast(i) && onJump(c)}
            disabled={isLast(i)}
            className={`rounded px-1.5 py-0.5 font-mono ${
              isLast(i) ? lastClass : "bg-muted text-muted-foreground hover:bg-muted/70 hover:text-foreground"
            }`}
          >
            {c.function}
          </button>
          {!isLast(i) && <span className="text-muted-foreground">→</span>}
        </span>
      ))}
    </div>
  );
}
