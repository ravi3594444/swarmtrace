"""Console entry point for the SwarmTrace MCP gateway.

Example::

    swarmtrace-gateway --config agent-tools.json
    swarmtrace-gateway --config agent-tools.json --transport sse --port 8080
"""

from __future__ import annotations

import asyncio
import logging
import sys

import click

from swarmtrace.gateway_config import load_config
from swarmtrace.mcp_gateway import SwarmTraceMcpGateway


@click.command()
@click.option(
    "--config",
    "-c",
    required=True,
    type=click.Path(exists=True, dir_okay=False, readable=True),
    help="Path to the gateway JSON configuration file.",
)
@click.option(
    "--transport",
    "-t",
    default="sse",
    type=click.Choice(["stdio", "sse", "streamable-http"], case_sensitive=False),
    help="MCP transport to expose. Default: sse.",
)
@click.option(
    "--host",
    "-h",
    default="127.0.0.1",
    help="Host to bind for SSE/streamable-http transports.",
)
@click.option(
    "--port",
    "-p",
    default=8000,
    type=int,
    help="Port to bind for SSE/streamable-http transports.",
)
@click.option(
    "--log-level",
    default="INFO",
    type=click.Choice(["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"], case_sensitive=False),
    help="Log level.",
)
def main(config: str, transport: str, host: str, port: int, log_level: str) -> None:
    """Start the SwarmTrace MCP gateway."""
    logging.basicConfig(
        level=getattr(logging, log_level.upper()),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    cfg = load_config(config)
    cfg.host = host
    cfg.port = port
    cfg.log_level = log_level

    gateway = SwarmTraceMcpGateway(cfg)

    async def _start() -> None:
        await gateway.start()

    try:
        asyncio.run(_start())
    except Exception as exc:
        click.echo(f"Failed to start gateway: {exc}", err=True)
        sys.exit(1)

    if transport in ("sse", "streamable-http"):
        click.echo(f"SwarmTrace MCP gateway listening on {host}:{port} ({transport})")
    else:
        click.echo("SwarmTrace MCP gateway running on stdio")

    try:
        gateway.run(transport=transport)
    except Exception as exc:
        click.echo(f"Gateway error: {exc}", err=True)
        sys.exit(1)
    finally:
        try:
            asyncio.run(gateway.stop())
        except Exception as exc:
            click.echo(f"Gateway stop warning: {exc}", err=True)


if __name__ == "__main__":
    main()
