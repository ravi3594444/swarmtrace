import sys
from tracely.storage import get_traces, DB_PATH
import sqlite3


# ---------- helpers ----------

def _print_tree(traces, parent_id=None, indent=0):
    children = [t for t in traces if t[1] == parent_id]
    for t in children:
        id_, par, func, args, output, latency, error, timestamp, in_tok, out_tok, cost = t
        status = "ERROR" if error else "OK"
        prefix = "    " * indent + ("└── " if indent > 0 else "")
        print(f"{prefix}{func}() [{id_}] {latency}s | {in_tok}in/{out_tok}out | ${cost} | {status}")
        _print_tree(traces, id_, indent + 1)


# ---------- view ----------

def view():
    try:
        traces = get_traces()
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
        table.add_column("Latency",  style="yellow",  width=10)
        table.add_column("Tokens",   style="blue",    width=15)
        table.add_column("Cost",     style="magenta", width=12)
        table.add_column("Status",   width=8)

        for t in traces:
            id_, parent_id, func, args, output, latency, error, timestamp, in_tok, out_tok, cost = t
            status     = "[red]ERROR[/red]" if error else "[green]OK[/green]"
            tokens_str = f"{in_tok or 0}in/{out_tok or 0}out"
            table.add_row(id_, func, f"{latency}s", tokens_str, f"${cost or 0}", status)

        console.print(table)

        console.print("\n[bold cyan]=== Agent Tree ===[/bold cyan]")
        roots = [t for t in traces if t[1] is None]
        for root in roots:
            id_, par, func, args, output, latency, error, timestamp, in_tok, out_tok, cost = root
            tree = Tree(
                f"[green]{func}()[/green] [{id_}] [yellow]{latency}s[/yellow] [magenta]${cost}[/magenta]"
            )

            def add_children(tree_node, pid):
                for child in [t for t in traces if t[1] == pid]:
                    cid, _, cfunc, _, _, clatency, cerror, _, _, _, ccost = child
                    status = "[red]ERROR[/red]" if cerror else "[green]OK[/green]"
                    branch = tree_node.add(
                        f"[blue]{cfunc}()[/blue] [{cid}] [yellow]{clatency}s[/yellow]"
                        f" [magenta]${ccost}[/magenta] {status}"
                    )
                    add_children(branch, cid)

            add_children(tree, id_)
            console.print(tree)

        console.print(f"\n[bold]Total traces:[/bold] {len(traces)}")
        console.print(f"[bold]Total tokens:[/bold] {total_tokens}")
        console.print(f"[bold]Total cost:[/bold] [magenta]${round(total_cost, 6)}[/magenta]")

    except ImportError:
        print("\n=== swarmtrace Trace View ===")
        for t in traces:
            id_, parent_id, func, args, output, latency, error, timestamp, in_tok, out_tok, cost = t
            status = "ERROR" if error else "OK"
            print(f"{id_:<10} {func:<20} {str(latency)+'s':<10} ${cost or 0} {status}")
        _print_tree(traces)
        print(f"Total: {len(traces)} traces | ${round(total_cost, 6)}")


# ---------- replay ----------

def replay(trace_id):
    try:
        conn  = sqlite3.connect(DB_PATH)
        trace = conn.execute("SELECT * FROM traces WHERE id = ?", (trace_id,)).fetchone()
        conn.close()
    except Exception:
        trace = None

    if not trace:
        print(f"Trace {trace_id} not found.")
        return

    id_, parent_id, func, args, output, latency, error, timestamp, in_tok, out_tok, cost = trace

    try:
        from rich.console import Console
        from rich.panel import Panel
        console = Console()
        console.print(Panel(
            f"[cyan]Function:[/cyan]  {func}\n"
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


if __name__ == "__main__":
    view()