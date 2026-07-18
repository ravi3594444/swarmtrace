"""Configuration loader for the SwarmTrace MCP gateway.

The gateway is configured with a JSON file that points to one or more upstream
MCP servers. Each upstream is described by the command used to start it, its
arguments, and optional environment variables or working directory.

Example configuration::

    {
      "servers": [
        {
          "name": "scraper",
          "command": "python",
          "args": ["-m", "mcp_server_scraper"],
          "env": {"SCRAPER_TIMEOUT": "30"},
          "cwd": "/opt/tools"
        }
      ]
    }

The gateway also accepts the common Claude Desktop / MCP-style shape so users
can reuse existing configuration files::

    {
      "mcpServers": {
        "scraper": {
          "command": "python",
          "args": ["-m", "mcp_server_scraper"]
        }
      }
    }
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


@dataclass
class UpstreamServer:
    """One upstream MCP server the gateway will proxy."""

    name: str
    command: str
    args: List[str] = field(default_factory=list)
    env: Optional[Dict[str, str]] = None
    cwd: Optional[str] = None
    tool_prefix: Optional[str] = None


@dataclass
class GatewayConfig:
    """Top-level gateway configuration."""

    servers: List[UpstreamServer]
    host: str = "127.0.0.1"
    port: int = 8000
    log_level: str = "INFO"


def _load_upstream(name: str, data: Dict[str, Any]) -> UpstreamServer:
    """Parse a single upstream server definition."""
    env = data.get("env")
    if env is not None and not isinstance(env, dict):
        raise ValueError(f"upstream {name!r}: env must be a dict of strings")

    cwd = data.get("cwd")
    if cwd is not None and not isinstance(cwd, str):
        raise ValueError(f"upstream {name!r}: cwd must be a string")

    args = data.get("args", [])
    if not isinstance(args, list):
        raise ValueError(f"upstream {name!r}: args must be a list of strings")

    command = data.get("command")
    if not command or not isinstance(command, str):
        raise ValueError(f"upstream {name!r}: command is required and must be a string")

    return UpstreamServer(
        name=name,
        command=command,
        args=[str(a) for a in args],
        env={str(k): str(v) for k, v in env.items()} if env else None,
        cwd=cwd,
        tool_prefix=data.get("tool_prefix"),
    )


def load_config(path: str) -> GatewayConfig:
    """Load a gateway configuration from a JSON file.

    Supports both the generic ``servers`` array and the Claude Desktop-style
    ``mcpServers`` object. Environment variables are NOT substituted; the
    gateway keeps upstream credentials local and does not read them into the
    trace payload.
    """
    if not os.path.isfile(path):
        raise FileNotFoundError(f"gateway config not found: {path}")

    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)

    if not isinstance(data, dict):
        raise ValueError("gateway config must be a JSON object")

    servers: List[UpstreamServer] = []

    generic_servers = data.get("servers")
    if generic_servers is not None:
        if not isinstance(generic_servers, list):
            raise ValueError("'servers' must be a list")
        for entry in generic_servers:
            if not isinstance(entry, dict):
                raise ValueError("each entry in 'servers' must be an object")
            name = entry.get("name")
            if not name:
                raise ValueError("each server entry must have a 'name'")
            servers.append(_load_upstream(str(name), entry))

    mcp_servers = data.get("mcpServers")
    if mcp_servers is not None:
        if not isinstance(mcp_servers, dict):
            raise ValueError("'mcpServers' must be a dict")
        for name, entry in mcp_servers.items():
            if not isinstance(entry, dict):
                raise ValueError(f"mcpServers.{name} must be an object")
            servers.append(_load_upstream(str(name), entry))

    if not servers:
        raise ValueError("gateway config must define at least one server")

    return GatewayConfig(
        servers=servers,
        host=str(data.get("host", "127.0.0.1")),
        port=int(data.get("port", 8000)),
        log_level=str(data.get("log_level", "INFO")),
    )


def save_config(path: str, config: GatewayConfig) -> None:
    """Write a gateway configuration to a JSON file."""
    payload = {
        "servers": [
            {
                "name": s.name,
                "command": s.command,
                "args": s.args,
                "env": s.env,
                "cwd": s.cwd,
                "tool_prefix": s.tool_prefix,
            }
            for s in config.servers
        ],
        "host": config.host,
        "port": config.port,
        "log_level": config.log_level,
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)


__all__ = ["UpstreamServer", "GatewayConfig", "load_config", "save_config"]
