import { createFileRoute } from "@tanstack/react-router";
import { Fragment, useState, useEffect } from "react";
import { DEMO_TRACES, type Trace } from "@/lib/traces-data";
import { SwarmLayout } from "@/components/swarm/Layout";
import { DetailDrawer } from "@/components/swarm/DetailDrawer";
import { CallChainCrumbs } from "@/components/swarm/CallChainCrumbs";

export const Route = createFileRoute("/failures")({
  head: () => ({
    meta: [
      { title: "SwarmTrace — Failures" },
      { name: "description", content: "Traces that errored during the latest agent run." },
      { property: "og:title", content: "SwarmTrace — Failures" },
      { property: "og:description", content: "Traces that errored during the latest agent run." },
    ],
  }),
  component: Failures,
});

function formatTime(iso: string) {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function Failures() {
  const [allTraces, setAllTraces] = useState<Trace[]>(DEMO_TRACES);
  const [selected, setSelected] = useState<Trace | null>(null);

  useEffect(() => {
    fetch(`${import.meta.env.VITE_API_BASE_URL}/traces`)
      .then((r) => r.json())
      .then((json) => setAllTraces((json.traces ?? json) as Trace[]))
      .catch(() => {});
  }, []);

  const failed = allTraces.filter((t) => t.error);

  return (
    <SwarmLayout>
      <div className="space-y-8">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Failures
            <span className="mx-3 text-border">/</span>
            <span className="font-mono text-sm text-destructive">{failed.length} errored</span>
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            Traces that did not complete successfully in the latest run
          </p>
        </div>

        {failed.length === 0 ? (
          <div className="border border-[oklch(0.7_0.18_145)]/30 bg-[oklch(0.7_0.18_145)]/5 px-6 py-16 text-center">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full border border-[oklch(0.7_0.18_145)]/40 bg-[oklch(0.7_0.18_145)]/10">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-7 w-7 text-[oklch(0.7_0.18_145)]">
                <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <div className="mt-4 font-mono text-[11px] uppercase tracking-[0.2em] text-[oklch(0.7_0.18_145)]">All systems clean</div>
            <p className="mt-1 text-xs text-muted-foreground">
              No failures detected in the latest run.
            </p>
          </div>
        ) : (
          <div className="overflow-hidden border border-border bg-card">
            <div className="flex items-center justify-between border-b border-border bg-muted/30 px-4 py-2.5 font-mono text-[11px] uppercase tracking-[0.16em] font-bold text-muted-foreground">
              <span>Failed Traces</span>
              <span className="text-[10px] text-muted-foreground/60">{failed.length} ROWS</span>
            </div>
            <table className="w-full font-mono text-[11px]">
              <thead className="border-b border-border bg-muted/20">
                <tr>
                  <th className="px-4 py-3 text-left font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">ID</th>
                  <th className="px-4 py-3 text-left font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">Function</th>
                  <th className="px-4 py-3 text-right font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">Latency</th>
                  <th className="px-4 py-3 text-center font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">Status</th>
                  <th className="px-4 py-3 text-left font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">Time</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60 text-muted-foreground">
                {failed.map((t) => (
                  <Fragment key={t.id}>
                    <tr
                      onClick={() => setSelected(t)}
                      className="cursor-pointer transition-colors hover:bg-muted/30"
                    >
                      <td className="px-4 pt-3 text-muted-foreground/60">{t.id}</td>
                      <td className="px-4 pt-3 text-foreground">{t.function}</td>
                      <td className="px-4 pt-3 text-right tabular-nums">{t.latency_sec.toFixed(2)}s</td>
                      <td className="px-4 pt-3 text-center">
                        <span className="text-[10px] font-bold uppercase text-destructive">FAIL</span>
                      </td>
                      <td className="px-4 pt-3 text-muted-foreground/70">
                        {formatTime(t.timestamp)}
                      </td>
                    </tr>
                    <tr>
                      <td colSpan={5} className="px-4 pb-4 pt-2">
                        <div className="border-l-2 border-destructive bg-destructive/5 px-3 py-2 font-mono text-xs text-destructive">
                          {t.error}
                        </div>
                        <div className="mt-2 flex items-center gap-2">
                          <span className="font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
                            Call chain
                          </span>
                          <CallChainCrumbs
                            trace={t}
                            allTraces={allTraces}
                            onJump={setSelected}
                          />
                        </div>
                      </td>
                    </tr>
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <DetailDrawer
        trace={selected}
        allTraces={allTraces}
        onClose={() => setSelected(null)}
        onJump={(t) => setSelected(t)}
      />
    </SwarmLayout>
  );
}