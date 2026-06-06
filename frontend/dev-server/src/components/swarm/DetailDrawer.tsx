import { useEffect } from "react";
import type { Trace } from "@/lib/traces-data";
import { getSiblings } from "@/lib/trace-utils";
import { SmartJson } from "./SmartJson";
import { CallChainCrumbs } from "./CallChainCrumbs";

export function DetailDrawer({
  trace,
  allTraces,
  onClose,
  onJump,
}: {
  trace: Trace | null;
  allTraces: Trace[];
  onClose: () => void;
  onJump: (t: Trace) => void;
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  if (!trace) return null;
  const ok = !trace.error;
  const parent = trace.parent_id ? allTraces.find((t) => t.id === trace.parent_id) : null;
  const siblings = getSiblings(trace, allTraces);

  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <aside className="absolute right-0 top-0 flex h-full w-full max-w-xl flex-col border-l border-border bg-card shadow-2xl">
        <header className="flex items-start justify-between border-b border-border px-5 py-4">
          <div className="min-w-0">
            <div className="truncate text-lg font-semibold text-foreground">{trace.function}</div>
            <div className="mt-0.5 font-mono text-xs text-muted-foreground">{trace.id}</div>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        <div className="flex-1 space-y-5 overflow-y-auto p-5">
          {!ok && (
            <section className="rounded-lg border border-destructive/50 bg-destructive/10 p-4">
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-destructive" />
                <h2 className="text-sm font-semibold text-destructive">Failure Analysis</h2>
              </div>
              <pre className="mt-3 overflow-x-auto rounded border border-destructive/40 bg-background/40 p-3 font-mono text-xs text-destructive">
                {trace.error}
              </pre>

              <div className="mt-4">
                <div className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
                  Triggering args
                </div>
                <SmartJson raw={trace.args} maxHeight="180px" />
              </div>

              <div className="mt-4">
                <div className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
                  Call chain
                </div>
                <CallChainCrumbs
                  trace={trace}
                  allTraces={allTraces}
                  onJump={onJump}
                  variant="danger"
                />
              </div>

              {siblings.length > 0 && (
                <div className="mt-4">
                  <div className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
                    Retry context · sibling calls
                  </div>
                  <div className="space-y-1">
                    {siblings.map((s) => {
                      const sOk = !s.error;
                      return (
                        <button
                          key={s.id}
                          onClick={() => onJump(s)}
                          className="flex w-full items-center gap-2 rounded border border-border bg-background/40 px-2 py-1.5 text-left hover:bg-muted/40"
                        >
                          <span
                            className={`h-2 w-2 shrink-0 rounded-full ${
                              sOk ? "bg-primary" : "bg-destructive"
                            }`}
                          />
                          <span className="flex-1 truncate text-xs text-foreground">
                            {s.function}
                          </span>
                          <span className="font-mono text-[10px] text-muted-foreground">
                            {s.id}
                          </span>
                          <span
                            className={`rounded px-1 font-mono text-[10px] font-bold uppercase ${
                              sOk ? "text-primary" : "text-destructive"
                            }`}
                          >
                            {sOk ? "OK" : "ERR"}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </section>
          )}

          <div className="grid grid-cols-3 gap-3">
            <Metric label="Latency" value={`${trace.latency_sec.toFixed(2)}s`} />
            <Metric label="Tokens" value={`${trace.input_tokens} / ${trace.output_tokens}`} />
            <Metric label="Cost" value={`$${trace.cost_usd.toFixed(4)}`} />
          </div>

          <Field label="Parent">
            {parent ? (
              <button
                onClick={() => onJump(parent)}
                className="font-mono text-xs text-primary hover:underline"
              >
                {parent.id} — {parent.function}
              </button>
            ) : (
              <span className="font-mono text-xs text-muted-foreground">
                {trace.parent_id ?? "(root)"}
              </span>
            )}
          </Field>

          <Field label="Call chain">
            <CallChainCrumbs trace={trace} allTraces={allTraces} onJump={onJump} />
          </Field>

          <Field label="Timestamp">
            <span className="font-mono text-xs text-muted-foreground" suppressHydrationWarning>
              {trace.timestamp}
            </span>
          </Field>

          <Field label="Status">
            <span
              className={`inline-block rounded px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase ${
                ok ? "bg-primary/15 text-primary" : "bg-destructive/15 text-destructive"
              }`}
            >
              {ok ? "OK" : "ERROR"}
            </span>
          </Field>

          <Field label="Args">
            <SmartJson raw={trace.args} maxHeight="240px" />
          </Field>

          <Field label="Output">
            <SmartJson raw={trace.output} maxHeight="320px" />
          </Field>
        </div>
      </aside>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-border bg-background p-3">
      <div className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-1 font-mono text-sm text-foreground">{value}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
        {label}
      </div>
      {children}
    </div>
  );
}
