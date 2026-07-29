"""Generic MCP gateway for SwarmTrace.

The gateway exposes one local MCP server that proxies tool discovery and
invocation to a set of upstream MCP servers. It records a generic tool span
for every invocation without provider-specific code, and propagates trace
context when the caller provides it in the MCP request ``meta`` field.

Usage::

    from swarmtrace.gateway_config import load_config
    from swarmtrace.mcp_gateway import SwarmTraceMcpGateway

    config = load_config("agent-tools.json")
    gateway = SwarmTraceMcpGateway(config)
    asyncio.run(gateway.run_stdio())

The gateway is intentionally minimal in its first release: it proxies tool
calls, not prompts or resources. It is also a local sidecar only — it does not
upload upstream tool credentials to the SwarmTrace dashboard.
"""

from __future__ import annotations

import logging
import time
import uuid
from abc import ABC, abstractmethod
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from swarmtrace.gateway_config import GatewayConfig, UpstreamServer
from swarmtrace.redact import redact
from swarmtrace.runtime import get_runtime
from swarmtrace.span_model import SpanRecord
from swarmtrace.trace_context import TraceContext

_log = logging.getLogger("swarmtrace.mcp_gateway")

# Lazy import of the mcp SDK. The gateway is an optional extra; the module
# should still be importable when mcp is not installed so that tests and
# the CLI can fail gracefully with a helpful message.
_mcp = None  # type: ignore


def _ensure_mcp() -> Any:
    """Return the mcp module, raising a clear error if it is not installed."""
    global _mcp
    if _mcp is None:
        try:
            import mcp as _mcp_imported
            _mcp = _mcp_imported
        except ImportError as exc:
            raise ImportError(
                "The MCP gateway requires the 'mcp' package. "
                "Install it with: pip install swarmtrace[gateway]"
            ) from exc
    return _mcp


class Upstream(ABC):
    """Abstract upstream MCP server."""

    name: str

    @abstractmethod
    async def connect(self) -> None:
        """Establish the connection to the upstream server."""
        ...

    @abstractmethod
    async def close(self) -> None:
        """Close the connection."""
        ...

    @abstractmethod
    async def list_tools(self) -> List[Dict[str, Any]]:
        """Return a list of tool definitions, each with at least a 'name' key."""
        ...

    @abstractmethod
    async def call_tool(self, name: str, arguments: Dict[str, Any]) -> Any:
        """Invoke a tool on the upstream server and return its raw result."""
        ...


class StdioUpstream(Upstream):
    """Connect to an upstream MCP server over stdio."""

    def __init__(self, server: UpstreamServer) -> None:
        self.name = server.name
        self._server = server
        self._read_stream: Optional[Any] = None
        self._write_stream: Optional[Any] = None
        self._session: Optional[Any] = None
        self._stdio_cm: Optional[Any] = None
        self._session_cm: Optional[Any] = None

    def _params(self) -> Any:
        mcp = _ensure_mcp()
        return mcp.client.stdio.StdioServerParameters(
            command=self._server.command,
            args=list(self._server.args),
            env=self._server.env,
            cwd=self._server.cwd,
        )

    async def connect(self) -> None:
        mcp = _ensure_mcp()
        params = self._params()
        _log.info("connecting to upstream %s: %s", self.name, params.command)
        # Manually enter the context managers so the session stays alive across
        # multiple tool calls. __aexit__ is called in close().
        self._stdio_cm = mcp.client.stdio.stdio_client(params)
        self._read_stream, self._write_stream = await self._stdio_cm.__aenter__()
        self._session_cm = mcp.client.session.ClientSession(
            self._read_stream, self._write_stream
        )
        self._session = await self._session_cm.__aenter__()
        await self._session.initialize()

    async def close(self) -> None:
        if self._session_cm is not None:
            try:
                await self._session_cm.__aexit__(None, None, None)
            except Exception as exc:
                _log.debug("upstream %s session close warning: %s", self.name, exc)
            self._session_cm = None
        if self._stdio_cm is not None:
            try:
                await self._stdio_cm.__aexit__(None, None, None)
            except Exception as exc:
                _log.debug("upstream %s stdio close warning: %s", self.name, exc)
            self._stdio_cm = None
        self._session = None
        self._read_stream = None
        self._write_stream = None

    async def list_tools(self) -> List[Dict[str, Any]]:
        if self._session is None:
            raise RuntimeError(f"upstream {self.name} is not connected")
        result = await self._session.list_tools()
        tools = getattr(result, "tools", result)
        return [
            {
                "name": t.name,
                "description": getattr(t, "description", "") or "",
                "inputSchema": getattr(t, "inputSchema", {}) or {},
            }
            for t in tools
        ]

    async def call_tool(self, name: str, arguments: Dict[str, Any]) -> Any:
        if self._session is None:
            raise RuntimeError(f"upstream {self.name} is not connected")
        return await self._session.call_tool(name, arguments)


def _result_to_output(result: Any) -> str:
    """Convert a raw MCP CallToolResult into a string for the trace output field."""
    if result is None:
        return ""
    if isinstance(result, str):
        return result
    # Accept both mcp CallToolResult objects and plain dicts.
    if isinstance(result, dict):
        if result.get("isError"):
            content = result.get("content", [])
            return _content_to_text(content) or "upstream error"
        return _content_to_text(result.get("content", [])) or str(result)
    return str(result)[:4000]


def _content_to_text(content: Any) -> str:
    """Extract text from MCP content blocks."""
    if not content:
        return ""
    parts: List[str] = []
    for block in content:
        if isinstance(block, dict):
            text = block.get("text")
            if text is not None:
                parts.append(str(text))
        else:
            text = getattr(block, "text", None)
            if text is not None:
                parts.append(str(text))
    return "\n".join(parts)[:4000]


def _extract_context_from_meta(meta: Any) -> Optional[TraceContext]:
    """Look for a SwarmTrace trace context in the MCP request ``meta`` object."""
    if meta is None:
        return None
    st = getattr(meta, "_swarmtrace_context", None)
    if st is None and isinstance(meta, dict):
        st = meta.get("_swarmtrace_context")
    if not isinstance(st, dict):
        return None
    return TraceContext(
        span_id=str(st.get("span_id", "")),
        parent_span_id=st.get("parent_span_id"),
        trace_id=st.get("trace_id"),
        agent_id=st.get("agent_id"),
        agent_name=st.get("agent_name"),
        session_id=st.get("session_id"),
    )


def _parse_traceparent(traceparent: str) -> Optional[TraceContext]:
    """Parse a W3C traceparent header into a TraceContext.

    Format: ``00-<trace_id>-<span_id>-<flags>``. We treat the incoming span_id
    as the parent_span_id for the tool span we are about to create.
    """
    if not traceparent:
        return None
    parts = traceparent.split("-")
    if len(parts) < 3:
        return None
    trace_id = parts[1]
    parent_span_id = parts[2]
    if not trace_id or not parent_span_id:
        return None
    return TraceContext(
        span_id=parent_span_id,
        parent_span_id=parent_span_id,
        trace_id=trace_id,
        agent_id=None,
        agent_name=None,
    )


def _text_content(text: str) -> Any:
    """Build an mcp TextContent result."""
    mcp = _ensure_mcp()
    return mcp.types.TextContent(type="text", text=text)


class SwarmTraceMcpGateway:
    """Local MCP gateway that proxies tool calls and records generic tool spans."""

    def __init__(
        self,
        config: GatewayConfig,
        upstreams: Optional[Dict[str, Upstream]] = None,
    ) -> None:
        self._config = config
        self._upstreams: Dict[str, Upstream] = upstreams or {}
        if not self._upstreams:
            for server in config.servers:
                self._upstreams[server.name] = StdioUpstream(server)
        self._tool_to_upstream: Dict[str, str] = {}
        self._tool_info: Dict[str, Dict[str, Any]] = {}
        self._server: Optional[Any] = None

    def _make_server(self) -> Any:
        mcp = _ensure_mcp()
        return mcp.server.lowlevel.Server(name="swarmtrace-gateway")

    async def start(self) -> None:
        """Connect to all upstreams, discover tools, and register proxy handlers."""
        if self._server is None:
            self._server = self._make_server()
        mcp = _ensure_mcp()

        # mcp 1.x exposes `request_handlers` (a dict keyed by request type).
        # mcp 2.x made it private (`_request_handlers`) and switched to a
        # method-string keyed registry with params-type validation — a
        # breaking, incompatible dispatch protocol. pyproject pins
        # `mcp>=1,<2`; this guard turns an mcp 2.x accidental install into a
        # clear error instead of an obscure AttributeError.
        request_handlers = getattr(self._server, "request_handlers", None)
        if request_handlers is None:
            from importlib.metadata import PackageNotFoundError, version

            try:
                installed = version("mcp")
            except PackageNotFoundError:
                installed = "unknown"
            raise RuntimeError(
                "swarmtrace's MCP gateway requires mcp 1.x "
                f"(installed: mcp {installed}). "
                "Install a compatible version with: pip install 'mcp>=1,<2'"
            )
        request_handlers[mcp.types.ListToolsRequest] = self._handle_list_tools
        request_handlers[mcp.types.CallToolRequest] = self._handle_call_tool

        for upstream in self._upstreams.values():
            await upstream.connect()
            tools = await upstream.list_tools()
            for tool in tools:
                name = tool["name"]
                registered_name = self._register_name(name, upstream.name)
                self._tool_to_upstream[registered_name] = upstream.name
                self._tool_info[registered_name] = tool

        _log.info(
            "gateway ready: %d tool(s) from %d upstream server(s)",
            len(self._tool_to_upstream),
            len(self._upstreams),
        )

    async def stop(self) -> None:
        """Disconnect from all upstreams."""
        for upstream in list(self._upstreams.values()):
            try:
                await upstream.close()
            except Exception as exc:
                _log.warning("upstream %s close error: %s", upstream.name, exc)

    def _register_name(self, tool_name: str, upstream_name: str) -> str:
        """Return the name under which a tool is exposed on the gateway.

        If the same tool name exists on multiple upstream servers, the second
        and later collisions are prefixed with the upstream server name.
        """
        if tool_name not in self._tool_to_upstream:
            return tool_name
        prefixed = f"{upstream_name}.{tool_name}"
        if prefixed not in self._tool_to_upstream:
            return prefixed
        # Should be extremely rare, but make it deterministic.
        return f"{upstream_name}.{tool_name}.{uuid.uuid4().hex[:8]}"

    async def _handle_list_tools(self, request: Any) -> Any:
        """Return the aggregated tool list from all upstream servers."""
        mcp = _ensure_mcp()
        tools = [
            mcp.types.Tool(
                name=name,
                description=info.get("description", "") or "",
                inputSchema=info.get("inputSchema", {}) or {},
            )
            for name, info in self._tool_info.items()
        ]
        return mcp.types.ListToolsResult(tools=tools)

    async def _handle_call_tool(self, request: Any) -> Any:
        """Proxy a tool call upstream and record a generic tool span."""
        mcp = _ensure_mcp()
        params = request.params
        registered_name = params.name
        arguments = params.arguments or {}
        upstream_name = self._tool_to_upstream.get(registered_name)
        if upstream_name is None:
            return mcp.types.CallToolResult(
                content=[_text_content(f"unknown tool: {registered_name}")],
                isError=True,
            )
        upstream = self._upstreams[upstream_name]
        original_name = self._tool_info[registered_name]["name"]

        span_id = uuid.uuid4().hex
        start = time.perf_counter()
        start_time = datetime.now(timezone.utc)
        error: Optional[str] = None
        result_value: Any = None

        trace_ctx = _extract_context_from_meta(params.meta)
        # If the caller sent no context, record an orphan tool span rather than
        # invent a false parent.
        if trace_ctx is None:
            trace_ctx = TraceContext(
                span_id=span_id,
                parent_span_id=None,
                trace_id=span_id,
                agent_id=None,
                agent_name=None,
            )

        try:
            result_value = await upstream.call_tool(original_name, arguments)
            output = _result_to_output(result_value)
            return mcp.types.CallToolResult(content=[_text_content(output)])
        except Exception as exc:
            error = str(exc)
            return mcp.types.CallToolResult(
                content=[_text_content(f"upstream error: {error}")],
                isError=True,
            )
        finally:
            latency = round(time.perf_counter() - start, 3)
            span = SpanRecord(
                span_id=span_id,
                parent_span_id=trace_ctx.parent_span_id,
                trace_id=trace_ctx.trace_id,
                name=registered_name,
                kind="tool",
                start_time=start_time,
                end_time=datetime.now(timezone.utc),
                status="error" if error else "ok",
                latency_sec=latency,
                args=(redact(str(arguments)) or "")[:4000] if arguments else None,
                output=(redact(output) or "")[:4000] if (error is None and output) else None,
                error=(redact(error) or "")[:4000] if error else None,
                agent_id=trace_ctx.agent_id,
                agent_name=trace_ctx.agent_name,
                session_id=trace_ctx.session_id,
                attributes={
                    "provider": "mcp",
                    "upstream": upstream_name,
                    "original_tool_name": original_name,
                },
            )
            try:
                get_runtime().record(span)
            except Exception as exc:
                _log.warning("gateway span record warning: %s", exc)

    async def call_tool(
        self,
        name: str,
        arguments: Dict[str, Any],
        *,
        meta: Optional[Dict[str, Any]] = None,
    ) -> Any:
        """Synchronous-style helper for tests and embedded use.

        Builds a low-level ``CallToolRequest`` and dispatches it through the
        registered handler. This avoids needing to stand up a real transport in
        unit tests.
        """
        mcp = _ensure_mcp()
        request = mcp.types.CallToolRequest(
            method="tools/call",
            params=mcp.types.CallToolRequestParams(
                name=name,
                arguments=arguments,
                _meta=meta,
            ),
        )
        return await self._handle_call_tool(request)

    @asynccontextmanager
    async def _stdio_transport(self):
        """Yield the stdio read/write streams for the low-level server."""
        mcp = _ensure_mcp()
        async with mcp.server.stdio.stdio_server() as (read_stream, write_stream):
            yield read_stream, write_stream

    @asynccontextmanager
    async def _sse_transport(self):
        """Yield an ASGI app configured for SSE MCP transport."""
        mcp = _ensure_mcp()
        try:
            import uvicorn
            from starlette.applications import Starlette
            from starlette.routing import Route
        except ImportError as exc:
            raise ImportError(
                "SSE transport requires 'uvicorn' and 'starlette'. "
                "Install the gateway extra: pip install swarmtrace[gateway]"
            ) from exc

        transport = mcp.server.sse.SseServerTransport("/messages/")

        async def handle_sse(request):
            async with transport.connect_sse(
                request.scope, request.receive, request.send
            ) as (read_stream, write_stream):
                await self._server.run(
                    read_stream,
                    write_stream,
                    self._server.create_initialization_options(),
                )

        async def handle_messages(request):
            body = await request.body()
            await transport.handle_post_message(
                request.scope, request.receive, request.send, body
            )

        app = Starlette(
            routes=[
                Route("/sse", endpoint=handle_sse),
                Route("/messages/", endpoint=handle_messages, methods=["POST"]),
            ]
        )
        yield app

    async def run_stdio(self) -> None:
        """Run the gateway over stdio (blocking until stdin closes)."""
        if self._server is None:
            raise RuntimeError("gateway has not been started")
        async with self._stdio_transport() as (read_stream, write_stream):
            await self._server.run(
                read_stream,
                write_stream,
                self._server.create_initialization_options(),
            )

    async def run_sse(self) -> None:
        """Run the gateway over SSE on the configured host/port."""
        if self._server is None:
            raise RuntimeError("gateway has not been started")
        try:
            import uvicorn
        except ImportError as exc:
            raise ImportError(
                "SSE transport requires 'uvicorn'. "
                "Install the gateway extra: pip install swarmtrace[gateway]"
            ) from exc
        if self._config.host not in ("127.0.0.1", "localhost", "::1"):
            _log.warning(
                "MCP gateway SSE listening on non-loopback host %s; "
                "anyone who can reach this address can invoke proxied tools. "
                "Use a reverse proxy with authentication or bind to 127.0.0.1.",
                self._config.host,
            )
        async with self._sse_transport() as app:
            config = uvicorn.Config(
                app,
                host=self._config.host,
                port=self._config.port,
                log_level=self._config.log_level.lower(),
            )
            server = uvicorn.Server(config)
            await server.serve()

    def run(self, transport: str = "stdio") -> None:
        """Run the gateway server (blocking).

        Transport may be ``stdio`` or ``sse``. For async callers, use
        ``run_stdio()`` or ``run_sse()`` directly.
        """
        if self._server is None:
            raise RuntimeError("gateway has not been started")
        if transport == "stdio":
            import asyncio
            asyncio.run(self.run_stdio())
        elif transport in ("sse", "streamable-http"):
            import asyncio
            asyncio.run(self.run_sse())
        else:
            raise ValueError(f"unsupported transport: {transport}")

    def tools(self) -> Dict[str, Dict[str, Any]]:
        """Return a snapshot of registered tools."""
        return dict(self._tool_info)


__all__ = [
    "Upstream",
    "StdioUpstream",
    "SwarmTraceMcpGateway",
    "_extract_context_from_meta",
    "_parse_traceparent",
]
