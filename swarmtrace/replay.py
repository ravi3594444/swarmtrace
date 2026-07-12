"""Failure-listing helper for the swarmtrace CLI.

The actual :func:`replay` function lives in :mod:`swarmtrace.cli` and is
re-exported here for backwards compatibility.  :func:`show_failures` is a
convenience that prints a table of recent failed traces — its output is
now routed through the ``swarmtrace.replay`` logger so host applications
can capture or silence it via standard logging configuration.
"""

import logging

from swarmtrace.storage import get_traces

# replay() lives in swarmtrace.cli — import from there to avoid duplication.
from swarmtrace.cli import replay  # noqa: F401  (re-exported for backwards compat)

_log = logging.getLogger("swarmtrace.replay")


def show_failures():
    traces = get_traces(limit=50)
    failed = [t for t in traces if t["error"]]

    if not failed:
        _log.info("No failures found.")
        return

    _log.info("=== Failed Traces ===")
    _log.info("%-10s %-20s %-40s %s", "ID", "FUNCTION", "ERROR", "TIMESTAMP")
    _log.info("-" * 90)
    for t in failed:
        _log.info("%-10s %-20s %-40s %s", t["id"], t["function"], str(t["error"])[:38], t["timestamp"])
    _log.info("Total failures: %d", len(failed))
    _log.info("Replay any failure: from swarmtrace.replay import replay; replay('id')")
