"""Tests for the generic MCP gateway.

These tests require the optional ``mcp`` package. They are skipped when it is
not installed so the base test suite can run without gateway dependencies.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from swarmtrace.gateway_config import GatewayConfig, UpstreamServer
from swarmtrace.mcp_gateway import (
    SwarmTraceMcpGateway,
    _extract_context_from_meta,
    _parse_traceparent,
)
from swarmtrace.span_model import SpanRecord

try:
    import mcp
except ImportError:
    mcp = None

pytestmark = pytest.mark.skipif(mcp is None, reason="mcp package not installed")


class FakeUpstream:
    """In-memory upstream server for testing the gateway without subprocesses."""

    name = "fake"

    def __init__(self, tools: list[dict[str, Any]], responses: dict[str, Any]):
        self._tools = tools
        self._responses = responses
        self.connected = False
        self.calls: list[tuple] = []

    async def connect(self) -> None:
        self.connected = True

    async def close(self) -> None:
        self.connected = False

    async def list_tools(self) -> list[dict[str, Any]]:
        return list(self._tools)

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> Any:
        self.calls.append((name, arguments))
        if name in self._responses:
            response = self._responses[name]
            if isinstance(response, Exception):
                raise response
            return response
        raise RuntimeError(f"unknown tool: {name}")


def make_config() -> GatewayConfig:
    return GatewayConfig(servers=[UpstreamServer(name="fake", command="cmd")])


@pytest.fixture
def gateway() -> SwarmTraceMcpGateway:
    upstream = FakeUpstream(
        tools=[
            {
                "name": "echo",
                "description": "echo a message",
                "inputSchema": {
                    "type": "object",
                    "properties": {"message": {"type": "string"}},
                },
            }
        ],
        responses={
            "echo": {"content": [{"type": "text", "text": "hello world"}]},
        },
    )
    return SwarmTraceMcpGateway(make_config(), upstreams={"fake": upstream})


def test_gateway_discovers_and_proxies_tool(gateway, fake_runtime):
    async def _main():
        await gateway.start()
        assert "echo" in gateway.tools()
        return await gateway.call_tool("echo", {"message": "hi"})

    result = asyncio.run(_main())
    assert any("hello world" in c.text for c in result.content)

    spans = fake_runtime.repository.spans
    assert len(spans) == 1
    span = spans[0]
    assert isinstance(span, SpanRecord)
    assert span.name == "echo"
    assert span.kind == "tool"
    assert span.status == "ok"
    assert span.output == "hello world"
    assert span.attributes.get("provider") == "mcp"
    assert span.attributes.get("upstream") == "fake"
    assert span.attributes.get("original_tool_name") == "echo"


def test_gateway_records_error_span(gateway, fake_runtime):
    upstream = gateway._upstreams["fake"]
    upstream._responses["echo"] = RuntimeError("boom")

    async def _main():
        await gateway.start()
        return await gateway.call_tool("echo", {"message": "hi"})

    result = asyncio.run(_main())
    assert result.isError

    spans = fake_runtime.repository.spans
    assert len(spans) == 1
    assert spans[0].status == "error"
    assert "boom" in spans[0].error


def test_gateway_tool_name_collision():
    upstream1 = FakeUpstream(
        tools=[{"name": "echo", "description": "", "inputSchema": {}}],
        responses={"echo": {"content": [{"type": "text", "text": "a"}]}},
    )
    upstream1.name = "u1"
    upstream2 = FakeUpstream(
        tools=[{"name": "echo", "description": "", "inputSchema": {}}],
        responses={"echo": {"content": [{"type": "text", "text": "b"}]}},
    )
    upstream2.name = "u2"
    cfg = GatewayConfig(
        servers=[
            UpstreamServer(name="u1", command="cmd"),
            UpstreamServer(name="u2", command="cmd"),
        ]
    )
    gw = SwarmTraceMcpGateway(cfg, upstreams={"u1": upstream1, "u2": upstream2})

    async def _main():
        await gw.start()
        tools = gw.tools()
        assert "echo" in tools
        assert "u2.echo" in tools
        a = await gw.call_tool("echo", {})
        b = await gw.call_tool("u2.echo", {})
        return a, b

    a, b = asyncio.run(_main())
    assert any(c.text == "a" for c in a.content)
    assert any(c.text == "b" for c in b.content)


def test_gateway_propagates_context_from_meta(gateway, fake_runtime):
    async def _main():
        await gateway.start()
        result = await gateway.call_tool(
            "echo",
            {"message": "hi"},
            meta={
                "_swarmtrace_context": {
                    "span_id": "caller-span",
                    "parent_span_id": "parent-1",
                    "trace_id": "trace-1",
                    "agent_id": "agent-1",
                    "agent_name": "research-agent",
                    "session_id": "session-1",
                }
            },
        )
        return result

    asyncio.run(_main())

    span = fake_runtime.repository.spans[0]
    assert span.parent_span_id == "parent-1"
    assert span.trace_id == "trace-1"
    assert span.agent_id == "agent-1"
    assert span.agent_name == "research-agent"
    assert span.session_id == "session-1"


def test_parse_traceparent_valid():
    ctx = _parse_traceparent("00-abc123-def456-01")
    assert ctx is not None
    assert ctx.trace_id == "abc123"
    assert ctx.parent_span_id == "def456"


def test_parse_traceparent_invalid():
    assert _parse_traceparent("garbage") is None
    assert _parse_traceparent("") is None


def test_extract_context_from_meta_no_context():
    assert _extract_context_from_meta(None) is None
    assert _extract_context_from_meta({}) is None


def test_extract_context_from_meta():
    ctx = _extract_context_from_meta(
        {"_swarmtrace_context": {"trace_id": "t", "parent_span_id": "p"}}
    )
    assert ctx is not None
    assert ctx.trace_id == "t"
    assert ctx.parent_span_id == "p"


def test_ensure_mcp_returns_module():
    # When mcp is installed, _ensure_mcp returns the module and caches it.
    from swarmtrace.mcp_gateway import _ensure_mcp
    mod = _ensure_mcp()
    assert mod is mcp
    # Second call returns the cached module.
    assert _ensure_mcp() is mod
