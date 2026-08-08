"""Tests for the gateway configuration loader."""

from __future__ import annotations

import json
import os
from collections.abc import Generator

import pytest

from swarmtrace.gateway_config import GatewayConfig, UpstreamServer, load_config, save_config


@pytest.fixture
def tmp_config(tmp_path) -> Generator[str, None, None]:
    path = str(tmp_path / "gateway.json")
    yield path
    if os.path.exists(path):
        os.remove(path)


def test_load_generic_servers(tmp_config):
    payload = {
        "servers": [
            {
                "name": "scraper",
                "command": "python",
                "args": ["-m", "mcp_server_scraper"],
                "env": {"TIMEOUT": "30"},
                "cwd": "/opt/tools",
            }
        ],
        "host": "0.0.0.0",
        "port": 9000,
    }
    with open(tmp_config, "w") as f:
        json.dump(payload, f)

    cfg = load_config(tmp_config)
    assert isinstance(cfg, GatewayConfig)
    assert len(cfg.servers) == 1
    server = cfg.servers[0]
    assert server.name == "scraper"
    assert server.command == "python"
    assert server.args == ["-m", "mcp_server_scraper"]
    assert server.env == {"TIMEOUT": "30"}
    assert server.cwd == "/opt/tools"
    assert cfg.host == "0.0.0.0"
    assert cfg.port == 9000


def test_load_mcp_servers_shape(tmp_config):
    payload = {
        "mcpServers": {
            "github": {
                "command": "npx",
                "args": ["-y", "@modelcontextprotocol/server-github"],
                "env": {"GITHUB_PERSONAL_ACCESS_TOKEN": "secret"},
            }
        }
    }
    with open(tmp_config, "w") as f:
        json.dump(payload, f)

    cfg = load_config(tmp_config)
    assert len(cfg.servers) == 1
    server = cfg.servers[0]
    assert server.name == "github"
    assert server.command == "npx"
    assert server.args == ["-y", "@modelcontextprotocol/server-github"]
    assert server.env == {"GITHUB_PERSONAL_ACCESS_TOKEN": "secret"}


def test_load_missing_file(tmp_path):
    with pytest.raises(FileNotFoundError):
        load_config(str(tmp_path / "missing.json"))


def test_load_no_servers(tmp_config):
    with open(tmp_config, "w") as f:
        json.dump({"host": "127.0.0.1"}, f)
    with pytest.raises(ValueError, match="at least one server"):
        load_config(tmp_config)


def test_load_bad_env_type(tmp_config):
    payload = {"servers": [{"name": "x", "command": "cmd", "env": "not-a-dict"}]}
    with open(tmp_config, "w") as f:
        json.dump(payload, f)
    with pytest.raises(ValueError, match="env must be a dict"):
        load_config(tmp_config)


def test_save_config_round_trip(tmp_config):
    cfg = GatewayConfig(
        servers=[
            UpstreamServer(
                name="echo", command="python", args=["-m", "echo_server"], env={"K": "v"}
            )
        ],
        host="localhost",
        port=7000,
    )
    save_config(tmp_config, cfg)
    loaded = load_config(tmp_config)
    assert loaded.servers[0].name == "echo"
    assert loaded.servers[0].env == {"K": "v"}
    assert loaded.host == "localhost"
    assert loaded.port == 7000


def test_load_both_shapes_merged(tmp_config):
    payload = {
        "servers": [{"name": "a", "command": "cmd1"}],
        "mcpServers": {"b": {"command": "cmd2"}},
    }
    with open(tmp_config, "w") as f:
        json.dump(payload, f)
    cfg = load_config(tmp_config)
    assert {s.name for s in cfg.servers} == {"a", "b"}
