'use client'

import { useEffect } from "react";
import type { Trace } from "@/lib/trace-types";
import { getSiblings } from "@/lib/trace-utils";
import { SmartJson } from "./SmartJson";
import { CallChainCrumbs } from "./CallChainCrumbs";
import { X, Clock, Coins, Activity, AlertTriangle } from "lucide-react";

export function DetailDrawer({ trace, allTraces, onClose, onJump }: {
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

  // Lock body scroll while the drawer is open — matches UsageBreakdownDrawer
  // and prevents the background page from scrolling behind the drawer.
  useEffect(() => {
    if (!trace) return;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = ""; };
  }, [trace]);

  if (!trace) return null;
  const ok       = !trace.error;
  const parent   = trace.parent_id ? allTraces.find((t) => t.id === trace.parent_id) : null;
  const siblings = getSiblings(trace, allTraces);

  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-foreground/10 backdrop-blur-sm animate-backdrop-fade-in" onClick={onClose} />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={`Trace detail: ${trace.function}`}
        className="absolute right-0 top-0 flex h-full w-full max-w-lg flex-col border-l border-border bg-card shadow-2xl animate-drawer-slide-in transition-[background-color,border-color,color] duration-200"
      >
        <header className="flex items-start justify-between border-b border-border px-5 py-4 bg-muted/20">
          <div className="min-w-0">
            <div className="text-base font-semibold truncate text-foreground">{trace.function}</div>
            <div className="mt-0.5 text-xs text-muted-foreground">{trace.id}</div>
          </div>
          <button onClick={onClose} aria-label="Close detail drawer" className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors ml-3 shrink-0">
            <X className="w-4 h-4" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {!ok && (
            <div className="rounded-xl border border-red-200 bg-red-50 p-4 space-y-3">
              <div className="flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-red-600 shrink-0" />
                <span className="text-sm font-semibold text-red-700">Failure Analysis</span>
              </div>
              <pre className="overflow-x-auto rounded-lg border border-red-200 bg-white p-3 text-xs text-red-700">
                {trace.error}
              </pre>
              <div>
                <div className="mb-2 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Call chain</div>
                <CallChainCrumbs trace={trace} allTraces={allTraces} onJump={onJump} />
              </div>
              {siblings.length > 0 && (
                <div>
                  <div className="mb-2 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Sibling calls</div>
                  <div className="space-y-1">
                    {siblings.map((s) => {
                      const sOk = !s.error;
                      return (
                        <button key={s.id} onClick={() => onJump(s)}
                          className="flex w-full items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-left hover:bg-muted/60 transition-colors">
                          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${sOk ? "bg-emerald-500" : "bg-red-400"}`} />
                          <span className="flex-1 truncate text-xs text-foreground">{s.function}</span>
                          <span className="text-[11px] text-muted-foreground">{s.id}</span>
                          <span className={`rounded-full px-1.5 py-0.5 border text-[10px] font-bold uppercase ${sOk ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-red-50 text-red-700 border-red-200"}`}>
                            {sOk ? "OK" : "ERR"}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="grid grid-cols-3 gap-3">
            {[
              { label: "Latency", value: `${trace.latency_sec.toFixed(2)}s`, icon: Clock    },
              { label: "Tokens",  value: `${trace.input_tokens}/${trace.output_tokens}`,    icon: Activity },
              { label: "Cost",    value: `$${trace.cost_usd.toFixed(4)}`,    icon: Coins    },
            ].map(({ label, value, icon: Icon }) => (
              <div key={label} className="rounded-xl border border-border bg-muted/30 p-3 text-center">
                <Icon className="w-3.5 h-3.5 text-muted-foreground mx-auto mb-1" />
                <div className="text-xs font-bold text-foreground">{value}</div>
                <div className="text-[10px] text-muted-foreground mt-0.5">{label}</div>
              </div>
            ))}
          </div>

          <Field label="Status">
            <span className={`inline-block rounded-full px-2.5 py-1 text-xs font-bold uppercase border ${
              ok ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-red-50 text-red-700 border-red-200"
            }`}>{ok ? "SUCCESS" : "ERROR"}</span>
          </Field>

          <Field label="Parent">
            {parent ? (
              <button onClick={() => onJump(parent)} className="text-xs text-foreground underline underline-offset-2 hover:text-muted-foreground transition-colors">
                {parent.id} — {parent.function}
              </button>
            ) : (
              <span className="text-xs text-muted-foreground">{trace.parent_id ?? "(root)"}</span>
            )}
          </Field>

          <Field label="Call chain">
            <CallChainCrumbs trace={trace} allTraces={allTraces} onJump={onJump} />
          </Field>

          <Field label="Timestamp">
            <span className="text-xs text-muted-foreground">{trace.timestamp}</span>
          </Field>

          <Field label="Arguments"><SmartJson raw={trace.args} maxHeight="200px" /></Field>
          <Field label="Output"><SmartJson raw={trace.output} maxHeight="280px" /></Field>
        </div>
      </aside>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-2 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">{label}</div>
      {children}
    </div>
  );
}