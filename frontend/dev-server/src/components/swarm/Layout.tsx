import { Link, Outlet } from "@tanstack/react-router";
import type { ReactNode } from "react";

export function SwarmLayout({
  children,
  rightSlot,
}: {
  children?: ReactNode;
  rightSlot?: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-sidebar">
        <div className="mx-auto flex max-w-6xl items-center gap-8 px-6 py-4">
          <div className="flex items-center gap-2.5">
            <span className="font-bold tracking-tight text-foreground">
              SWARM<span className="text-primary">TRACE</span>
            </span>
            <span className="rounded-sm border border-border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              v0.4.2
            </span>
          </div>
          <nav className="flex items-center gap-6 text-sm font-medium">
            <NavLink to="/">Dashboard</NavLink>
            <NavLink to="/traces">Traces</NavLink>
            <NavLink to="/failures">Failures</NavLink>
          </nav>
          <div className="ml-auto flex items-center gap-3">{rightSlot}</div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-8">{children ?? <Outlet />}</main>
    </div>
  );
}

function NavLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link
      to={to}
      activeOptions={{ exact: true }}
      activeProps={{ className: "text-foreground border-b border-primary" }}
      inactiveProps={{
        className:
          "text-muted-foreground hover:text-foreground border-b border-transparent",
      }}
      className="pb-[19px] -mb-[17px] transition-colors"
    >
      {children}
    </Link>
  );
}

export function LiveToggle({
  enabled,
  onToggle,
  lastPoll,
}: {
  enabled: boolean;
  onToggle: (v: boolean) => void;
  lastPoll: number | null;
}) {
  return (
    <div
      className="flex items-center gap-4 font-mono text-[11px] uppercase tracking-widest"
      title={
        enabled
          ? "Polling /traces every 2s"
          : "Live updates paused — click to start polling"
      }
    >
      <span className="flex items-center gap-2 text-muted-foreground">
        <span className="h-2 w-2 rounded-full border border-[oklch(0.7_0.18_145)] bg-[oklch(0.7_0.18_145)]/20" />
        SYSTEM LIVE
      </span>
      <span className="text-border">|</span>
      <span className="flex items-center gap-2">
        {enabled ? (
          <>
            <span className="h-1.5 w-1.5 rounded-full bg-primary swarm-pulse" />
            <span className="text-primary">LIVE</span>
          </>
        ) : (
          <span className="text-muted-foreground">PAUSED</span>
        )}
        {enabled && lastPoll && (
          <span
            className="text-muted-foreground/60 normal-case tracking-normal"
            suppressHydrationWarning
          >
            · {Math.max(0, Math.round((Date.now() - lastPoll) / 1000))}s
          </span>
        )}
      </span>
      <button
        onClick={() => onToggle(!enabled)}
        className={`relative h-4 w-8 rounded-full transition-colors ${
          enabled ? "bg-primary/40" : "bg-muted"
        }`}
        aria-label="Toggle live polling"
      >
        <span
          className={`absolute top-0.5 h-3 w-3 rounded-full transition-transform ${
            enabled
              ? "translate-x-4 bg-primary"
              : "translate-x-0.5 bg-muted-foreground/60"
          }`}
        />
      </button>
    </div>
  );
}
