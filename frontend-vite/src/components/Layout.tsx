import { Link, useLocation } from "wouter";
import { useState, type ReactNode } from "react";
import {
  LayoutGrid, Users, ActivitySquare, BarChart3, Settings,
  Zap, AlertTriangle, ChevronRight, Menu, X
} from "lucide-react";

const navItems = [
  { href: "/",         label: "Overview",  icon: LayoutGrid      },
  { href: "/agents",   label: "Agents",    icon: Users           },
  { href: "/traces",   label: "Traces",    icon: ActivitySquare  },
  { href: "/metrics",  label: "Metrics",   icon: BarChart3       },
  { href: "/failures", label: "Failures",  icon: AlertTriangle   },
  { href: "/settings", label: "Settings",  icon: Settings        },
];

function NavItem({
  href, label, icon: Icon, collapsed,
}: {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  collapsed: boolean;
}) {
  const [location] = useLocation();
  const isActive = href === "/" ? location === "/" : location.startsWith(href);

  return (
    <Link href={href}>
      <div
        title={collapsed ? label : undefined}
        className={`
          group relative flex items-center gap-3 rounded-lg text-sm font-medium
          transition-all duration-150 cursor-pointer
          ${collapsed ? "justify-center px-0 py-2.5 w-10 mx-auto" : "px-3 py-2.5 w-full"}
          ${isActive
            ? "text-primary"
            : "text-sidebar-foreground hover:bg-sidebar-border/60 hover:text-foreground"
          }
        `}
        style={isActive && !collapsed ? { background: "hsl(250 84% 54% / 0.08)" } : isActive && collapsed ? { background: "hsl(250 84% 54% / 0.08)", borderRadius: 8 } : {}}
      >
        <Icon
          className={`shrink-0 transition-colors ${collapsed ? "w-5 h-5" : "w-[17px] h-[17px]"} ${isActive ? "text-primary" : "text-muted-foreground group-hover:text-foreground"}`}
          strokeWidth={isActive ? 2.2 : 1.7}
        />
        {!collapsed && <span className="truncate">{label}</span>}
        {!collapsed && isActive && <ChevronRight className="w-3.5 h-3.5 ml-auto text-primary/50" />}

        {/* Tooltip when collapsed */}
        {collapsed && (
          <span className="pointer-events-none absolute left-full ml-2 z-50 whitespace-nowrap rounded-md border border-border bg-card px-2 py-1 text-xs font-medium text-foreground shadow-md opacity-0 group-hover:opacity-100 transition-opacity duration-150">
            {label}
          </span>
        )}
      </div>
    </Link>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(true);

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Sidebar */}
      <aside
        className="shrink-0 flex flex-col h-full bg-sidebar border-r border-sidebar-border transition-all duration-200 ease-in-out overflow-hidden"
        style={{ width: open ? 224 : 56 }}
      >
        {/* Logo + toggle */}
        <div className={`flex items-center border-b border-sidebar-border ${open ? "px-4 py-4 gap-2.5 justify-between" : "px-0 py-4 justify-center"}`}>
          {open && (
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="w-7 h-7 rounded-lg bg-primary flex items-center justify-center shrink-0 shadow-sm">
                <Zap className="w-4 h-4 text-white" strokeWidth={2.5} />
              </div>
              <div className="min-w-0">
                <div className="text-sm font-bold tracking-tight text-foreground leading-none">
                  Swarm<span className="text-primary">Trace</span>
                </div>
                <div className="text-[10px] text-muted-foreground mt-0.5">v0.4.2</div>
              </div>
            </div>
          )}
          <button
            onClick={() => setOpen((v) => !v)}
            className={`w-7 h-7 rounded-lg flex items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground transition-colors shrink-0 ${!open ? "mx-auto" : ""}`}
            title={open ? "Collapse sidebar" : "Expand sidebar"}
          >
            {open ? <X className="w-3.5 h-3.5" /> : <Menu className="w-4 h-4" />}
          </button>
        </div>

        {/* Collapsed logo icon */}
        {!open && (
          <div className="flex justify-center py-2 border-b border-sidebar-border">
            <div className="w-7 h-7 rounded-lg bg-primary flex items-center justify-center shadow-sm">
              <Zap className="w-4 h-4 text-white" strokeWidth={2.5} />
            </div>
          </div>
        )}

        {/* Nav */}
        <nav className={`flex-1 overflow-y-auto overflow-x-hidden py-3 ${open ? "px-3 space-y-0.5" : "px-0 space-y-1 flex flex-col items-center"}`}>
          {navItems.map((item) => (
            <NavItem key={item.href} {...item} collapsed={!open} />
          ))}
        </nav>

        {/* Footer */}
        {open && (
          <div className="p-3 border-t border-sidebar-border">
            <div className="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-muted/60">
              <div className="w-7 h-7 rounded-full bg-primary text-white flex items-center justify-center shrink-0 text-[11px] font-bold shadow-sm">
                ST
              </div>
              <div className="min-w-0">
                <div className="text-xs font-medium text-foreground truncate">admin@swarmtrace.ai</div>
                <div className="text-[10px] text-muted-foreground">Free plan</div>
              </div>
            </div>
          </div>
        )}
        {!open && (
          <div className="p-3 border-t border-sidebar-border flex justify-center">
            <div className="w-7 h-7 rounded-full bg-primary text-white flex items-center justify-center text-[11px] font-bold shadow-sm" title="admin@swarmtrace.ai">
              ST
            </div>
          </div>
        )}
      </aside>

      {/* Main */}
      <main className="flex-1 overflow-y-auto min-w-0 bg-background">
        {children}
      </main>
    </div>
  );
}

export function PageHeader({
  title, description, badge, liveStatus, actions,
}: {
  title: string;
  description?: string;
  badge?: ReactNode;
  liveStatus?: "live" | "paused" | "offline";
  actions?: ReactNode;
}) {
  return (
    <div className="sticky top-0 z-20 bg-background/90 backdrop-blur-sm border-b border-border px-6 py-4 flex items-center justify-between gap-4">
      <div className="min-w-0">
        <div className="flex items-center gap-3">
          <h1 className="text-base font-semibold text-foreground truncate">{title}</h1>
          {badge}
          {liveStatus && (
            <div className={`flex items-center gap-1.5 text-xs font-medium ${
              liveStatus === "live" ? "text-foreground" : "text-muted-foreground"
            }`}>
              <span className={`w-1.5 h-1.5 rounded-full ${
                liveStatus === "live" ? "bg-emerald-500 swarm-pulse" :
                liveStatus === "paused" ? "bg-amber-400" : "bg-muted-foreground"
              }`} />
              {liveStatus === "live" ? "LIVE" : liveStatus === "paused" ? "PAUSED" : "OFFLINE"}
            </div>
          )}
        </div>
        {description && <p className="text-xs text-muted-foreground mt-0.5">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}
