import sys
from swarmtrace.storage import get_traces, get_by_id

DEFAULT_VIEW_LIMIT = 100


def _parse_limit(default: int = DEFAULT_VIEW_LIMIT) -> int:
    """Parse an optional --limit N / --limit=N CLI flag."""
    args = sys.argv[1:]
    for i, arg in enumerate(args):
        if arg == "--limit" and i + 1 < len(args):
            try:
                return max(1, int(args[i + 1]))
            except ValueError:
                break
        if arg.startswith("--limit="):
            try:
                return max(1, int(arg.split("=", 1)[1]))
            except ValueError:
                break
    return default


# ---------- helpers ----------

def _print_tree(traces, parent_id=None, indent=0):
    children = [t for t in traces if t[1] == parent_id]
    for t in children:
        # `*_` swallows session_id, synced, and any future migration columns
        # so this doesn't break when storage.py adds fields. The CLI only reads
        # the first 14 columns by name; see storage.py:_ADDED_COLUMNS.
        id_, par, func, args, output, latency, error, timestamp, in_tok, out_tok, cost, kind, agent_id, agent_name, *_ = t
        status = "ERROR" if error else "OK"
        tag = "" if kind == "agent" else f" [{kind}]"
        prefix = "    " * indent + ("└── " if indent > 0 else "")
        print(f"{prefix}{func}(){tag} [{id_}] {latency}s | {in_tok}in/{out_tok}out | ${cost} | {status}")
        _print_tree(traces, id_, indent + 1)


# ---------- view ----------

def view(limit=None):
    """Show recent traces. Usage: swarmtrace [--limit N] (default 100)."""
    if limit is None:
        limit = _parse_limit()
    try:
        traces = get_traces(limit=limit)
    except Exception:
        traces = []

    if not traces:
        print("No traces found. Run your agent with @observe first.")
        return

    total_cost   = sum(t[10] for t in traces if t[10])
    total_tokens = sum((t[8] or 0) + (t[9] or 0) for t in traces)

    try:
        from rich.console import Console
        from rich.table import Table
        from rich.tree import Tree

        console = Console()

        table = Table(title="swarmtrace — Trace View", border_style="cyan")
        table.add_column("ID",       style="cyan",    width=10)
        table.add_column("Function", style="green",   width=20)
        table.add_column("Kind",     style="magenta", width=8)
        table.add_column("Latency",  style="yellow",  width=10)
        table.add_column("Tokens",   style="blue",    width=15)
        table.add_column("Cost",     style="magenta", width=12)
        table.add_column("Status",   width=8)

        for t in traces:
            id_, parent_id, func, args, output, latency, error, timestamp, in_tok, out_tok, cost, kind, agent_id, agent_name, *_ = t
            status     = "[red]ERROR[/red]" if error else "[green]OK[/green]"
            tokens_str = f"{in_tok or 0}in/{out_tok or 0}out"
            table.add_row(id_, func, kind, f"{latency}s", tokens_str, f"${cost or 0}", status)

        console.print(table)

        console.print("\n[bold cyan]=== Agent Tree ===[/bold cyan]")
        # The tree view shows STRUCTURE (parent → children), the table view
        # above shows STATUS (OK/ERROR). Don't duplicate status in the tree —
        # the extra "OK" / "ERROR" suffix was pushing branch labels past 80
        # cols and causing rich to wrap them onto a second line, breaking the
        # indentation. Errors are still visible in the table; users who want
        # full detail per trace use `swarmtrace-replay <id>`.
        roots = [t for t in traces if t[1] is None]
        for root in roots:
            id_, par, func, args, output, latency, error, timestamp, in_tok, out_tok, cost, kind, agent_id, agent_name, *_ = root
            tree = Tree(
                f"[green]{func}()[/green] [{id_}] [yellow]{latency:.3f}s[/yellow] [magenta]${cost or 0}[/magenta]"
            )

            def add_children(tree_node, pid):
                for child in [t for t in traces if t[1] == pid]:
                    cid, _, cfunc, _, _, clatency, cerror, _, _, _, ccost, ckind, *_ = child
                    ctag = "" if ckind == "agent" else f" [dim]({ckind})[/dim]"
                    tree_node.add(
                        f"[blue]{cfunc}()[/blue]{ctag} [{cid}] [yellow]{clatency:.3f}s[/yellow]"
                        f" [magenta]${ccost or 0}[/magenta]"
                    )
                    add_children(tree_node, cid)

            add_children(tree, id_)
            console.print(tree, soft_wrap=True)

        console.print(f"\n[bold]Total traces:[/bold] {len(traces)}")
        console.print(f"[bold]Total tokens:[/bold] {total_tokens}")
        console.print(f"[bold]Total cost:[/bold] [magenta]${round(total_cost, 6)}[/magenta]")

    except ImportError:
        print("\n=== swarmtrace Trace View ===")
        for t in traces:
            id_, parent_id, func, args, output, latency, error, timestamp, in_tok, out_tok, cost, kind, agent_id, agent_name, *_ = t
            status = "ERROR" if error else "OK"
            tag = "" if kind == "agent" else f" ({kind})"
            print(f"{id_:<10} {(func + tag):<20} {str(latency)+'s':<10} ${cost or 0} {status}")
        _print_tree(traces)
        print(f"Total: {len(traces)} traces | ${round(total_cost, 6)}")


# ---------- replay ----------

def replay(trace_id):
    trace = get_by_id(trace_id)

    if not trace:
        print(f"Trace {trace_id} not found.")
        return

    id_, parent_id, func, args, output, latency, error, timestamp, in_tok, out_tok, cost, kind, agent_id, agent_name, *_ = trace

    try:
        from rich.console import Console
        from rich.panel import Panel
        console = Console()
        console.print(Panel(
            f"[cyan]Function:[/cyan]  {func}\n"
            f"[cyan]Kind:[/cyan]      {kind}\n"
            f"[cyan]Agent:[/cyan]     {agent_name} ({agent_id})\n"
            f"[cyan]Timestamp:[/cyan] {timestamp}\n"
            f"[cyan]Args:[/cyan]      {args}\n"
            f"[cyan]Output:[/cyan]    {output}\n"
            f"[cyan]Latency:[/cyan]   {latency}s\n"
            f"[cyan]Tokens:[/cyan]    {in_tok}in / {out_tok}out\n"
            f"[cyan]Cost:[/cyan]      ${cost}\n"
            f"[cyan]Error:[/cyan]     {error if error else 'None'}\n"
            f"[cyan]Parent:[/cyan]    {parent_id if parent_id else 'root'}",
            title=f"[bold]swarmtrace replay: {trace_id}[/bold]",
            border_style="cyan"
        ))
    except ImportError:
        print(f"\n=== swarmtrace replay: {trace_id} ===")
        print(f"Function  : {func}")
        print(f"Kind      : {kind}")
        print(f"Agent     : {agent_name} ({agent_id})")
        print(f"Timestamp : {timestamp}")
        print(f"Args      : {args}")
        print(f"Output    : {output}")
        print(f"Latency   : {latency}s")
        print(f"Tokens    : {in_tok}in / {out_tok}out")
        print(f"Cost      : ${cost}")
        print(f"Error     : {error if error else 'None'}")
        print(f"Parent    : {parent_id if parent_id else 'root'}")


def main_replay():
    if len(sys.argv) < 2:
        print("Usage: swarmtrace-replay <trace_id>")
        print("\nRecent traces:")
        for t in get_traces(limit=5):
            print(f"  {t[0]} — {t[2]}() — {t[7]}")
        return
    replay(sys.argv[1])


# ---------- alerts ----------

def _alerts_list(limit: int = 20) -> None:
    from swarmtrace.alerts import list_alerts
    try:
        from rich.console import Console
        from rich.table import Table
        console = Console()
        rows = list_alerts(limit=limit)
        if not rows:
            console.print("[yellow]No alerts fired yet.[/yellow]")
            return
        t = Table(title=f"swarmtrace — Last {len(rows)} alerts", border_style="cyan")
        t.add_column("Fired",     style="cyan",   width=22)
        t.add_column("Severity",  width=10)
        t.add_column("Rule",      style="green",  width=22)
        t.add_column("Agent",     style="magenta", width=20)
        t.add_column("Message",   width=80)
        t.add_column("Ack",       width=5)
        for a in rows:
            sev = a["severity"].upper()
            sev_styled = {
                "INFO":     "[blue]INFO[/blue]",
                "WARNING":  "[yellow]WARN[/yellow]",
                "CRITICAL": "[red]CRIT[/red]",
            }.get(sev, sev)
            acked = "[green]✓[/green]" if a.get("acked") else "·"
            t.add_row(a["fired_at"][:19], sev_styled, a["rule"], a.get("agent_name") or "—", a["message"], acked)
        console.print(t)
    except ImportError:
        for a in list_alerts(limit=limit):
            print(f"{a['fired_at']}  [{a['severity']:8}] {a['rule']:22} {a.get('agent_name') or '—':20} {a['message']}")


def _alerts_test() -> None:
    """Run the rule engine once over the current traces and report any new alerts."""
    from swarmtrace.alerts import evaluate_now
    try:
        from rich.console import Console
        console = Console()
    except ImportError:
        console = None
    try:
        fired = evaluate_now()
    except Exception as exc:
        print(f"[swarmtrace] alert evaluation failed: {exc}", file=sys.stderr)
        sys.exit(1)
    if not fired:
        msg = "No rules tripped. All clear. ✅"
        if console:
            console.print(f"[green]{msg}[/green]")
        else:
            print(msg)
        return
    for a in fired:
        line = f"[{a.severity.upper():8}] {a.rule:22} {a.agent_name or '':20} {a.message}"
        if console:
            console.print(line)
        else:
            print(line)
    print(f"\n{len(fired)} alert(s) fired.")


def _alerts_ack(alert_id: str) -> None:
    from swarmtrace.alerts import acknowledge
    if acknowledge(alert_id):
        print(f"✓ Acknowledged {alert_id}")
    else:
        print(f"Alert {alert_id} not found.")
        sys.exit(1)


def main_alerts():
    """
    swarmtrace alerts <subcommand> [...]

    Subcommands:
      list [--limit N]  Show recent alerts (default 20)
      test              Run the rule engine once over the current traces
      ack <alert_id>    Mark an alert as acknowledged
    """
    args = sys.argv[1:]
    if not args or args[0] in ("-h", "--help"):
        print(main_alerts.__doc__)
        return
    sub = args[0]
    rest = args[1:]
    if sub == "list":
        limit = 20
        for i, a in enumerate(rest):
            if a == "--limit" and i + 1 < len(rest):
                try:
                    limit = int(rest[i + 1])
                except ValueError:
                    pass
        _alerts_list(limit=limit)
    elif sub == "test":
        _alerts_test()
    elif sub == "ack":
        if len(rest) < 1:
            print("Usage: swarmtrace alerts ack <alert_id>")
            sys.exit(1)
        _alerts_ack(rest[0])
    else:
        print(f"Unknown subcommand: {sub}")
        print(main_alerts.__doc__)
        sys.exit(1)


# ---------- resync ----------

def main_resync():
    """swarmtrace-resync — re-send traces that failed to reach the remote endpoint.

    Reads rows from the local SQLite DB where synced=0 (i.e. the background
    sender's 3 retries were exhausted, or the endpoint was unreachable when
    the trace was captured) and POSTs each one to /api/ingest again. On
    success, the row is marked synced=1.

    Use this after an endpoint outage, a network change, or any time the
    dashboard is missing traces you know were captured locally.

    Usage:
      swarmtrace-resync [--limit N]    # default: re-send up to 100 unsynced rows

    Exit code:
      0  all attempted rows sent successfully (or nothing to send)
      1  one or more rows still failed (re-run to retry)
    """
    from swarmtrace.tracer import resync as _resync

    limit = 100
    args = sys.argv[1:]
    for i, arg in enumerate(args):
        if arg in ("-h", "--help"):
            print(main_resync.__doc__)
            return
        if arg == "--limit" and i + 1 < len(args):
            try:
                limit = max(1, int(args[i + 1]))
            except ValueError:
                pass
        elif arg.startswith("--limit="):
            try:
                limit = max(1, int(arg.split("=", 1)[1]))
            except ValueError:
                pass

    attempted, succeeded, failed = _resync(batch_size=limit)

    if attempted == 0:
        print("No unsynced traces found. (Remote endpoint configured and "
              "up-to-date, or SWARMTRACE_API_KEY/SWARMTRACE_ENDPOINT not set.)")
        return

    print(f"Resync complete: {succeeded}/{attempted} traces sent successfully.")
    if failed:
        print(f"{failed} trace(s) still failed — re-run swarmtrace-resync to retry.")
        sys.exit(1)


if __name__ == "__main__":
    view()
