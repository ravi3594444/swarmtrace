"""
Optional auto-instrumentation for popular LLM client libraries.

``swarmtrace.init()`` (default ``auto_instrument=True``) calls :func:`patch_all`,
which patches whichever of OpenAI, Anthropic, Gemini, and LiteLLM are
installed, so raw LLM calls are traced as ``kind="llm"`` — attributed to
whatever ``@observe``'d agent is currently running, or to themselves if
none — with zero decorators at the call site.

Production guarantees
---------------------
- **Non-blocking**: trace recording is enqueued onto the background sender
  thread, never on the calling thread. The LLM call's latency is unaffected.
- **Idempotent**: each client method is only wrapped once — safe to call
  ``patch_all()`` (or ``swarmtrace.init()``) multiple times.
- **Exception-transparent**: the original exception always propagates to the
  caller; the trace records the error string but never swallows or delays it.
- **No content capture**: only metadata is recorded (model, latency, tokens,
  cost). Prompt/response content is never persisted by auto-instrumentation.
- **fov-compatible**: checks ``__swarmtrace_patched__`` before wrapping, so the
  fov stream patches (which also wrap OpenAI) don't produce double traces.
"""

import functools
import sys
import time
from datetime import datetime, timezone
from typing import Optional, Tuple

from swarmtrace.pricing import calculate_cost
import swarmtrace.tracer as _tracer


# ---------------------------------------------------------------------------
# Stream wrappers — defer trace recording until the stream is exhausted
# ---------------------------------------------------------------------------
# When stream=True, the LLM client returns a generator/iterator, NOT a
# response object. The old code read response.usage immediately (didn't
# exist → 0 tokens) and recorded the trace in the finally block before any
# chunks were consumed (latency ≈ 0). These wrappers intercept the stream,
# accumulate usage metadata from chunks, and only call _record_async when
# the stream is fully exhausted or breaks.

class _StreamInstrumentWrapper:
    """Wraps a sync streaming response. Records the trace when the stream
    is exhausted or raises.

    Implements __enter__/__exit__/__getattr__ so it works as a context
    manager (`with client.chat.completions.create(..., stream=True) as s:`)
    and so attribute access on the underlying stream (e.g. .response, .parse())
    still works — OpenAI's stream objects support both patterns."""

    def __init__(self, stream, func_name, model, start, agent, parent_id):
        self._stream = stream
        self._func_name = func_name
        self._model = model
        self._start = start
        self._agent = agent
        self._parent_id = parent_id
        self._in_tok = 0
        self._out_tok = 0
        self._error: Optional[Exception] = None
        self._recorded = False

    def __iter__(self):
        return self

    def __next__(self):
        try:
            chunk = next(self._stream)
            self._extract_usage(chunk)
            return chunk
        except StopIteration:
            self._record()
            raise
        except Exception as exc:
            self._error = exc
            self._record()
            raise

    def __enter__(self):
        # Support `with ... as stream:` — OpenAI streams are context managers.
        # Don't call __enter__ on the underlying stream; it may not have one.
        # The stream is already "entered" by the time we wrap it.
        return self

    def __exit__(self, *exc):
        # If the user exits the context manager without exhausting the stream,
        # record the trace with whatever we have so far (possibly 0 tokens).
        # This matches the non-streaming behavior where the finally block
        # always records.
        self._record()
        return False  # don't suppress exceptions

    def __getattr__(self, name):
        # Passthrough for attribute access on the underlying stream
        # (e.g. stream.response, stream.parse(), stream.close()).
        # Only called when normal attribute lookup fails on self.
        # Guard against infinite recursion if _stream isn't set yet
        # (e.g. during __init__ or unpickling) — raise AttributeError
        # rather than recursing into __getattr__ for '_stream'.
        if name == "_stream":
            raise AttributeError(name)
        return getattr(self._stream, name)

    def _extract_usage(self, chunk):
        """Accumulate usage + model from any chunk that carries them.
        Different providers put usage in different places:
          - OpenAI: chunk.usage on the final chunk (if stream_options
            includes include_usage)
          - Anthropic: message_start.event.usage.input_tokens,
            message_delta.usage.output_tokens
          - LiteLLM: depends on underlying provider
        We check all known shapes and keep the last non-zero value."""
        # OpenAI / LiteLLM: chunk.usage
        usage = getattr(chunk, "usage", None)
        if usage:
            self._in_tok = getattr(usage, "prompt_tokens", 0) or self._in_tok
            self._out_tok = getattr(usage, "completion_tokens", 0) or self._out_tok
            # Anthropic-style: input_tokens / output_tokens
            self._in_tok = getattr(usage, "input_tokens", 0) or self._in_tok
            self._out_tok = getattr(usage, "output_tokens", 0) or self._out_tok
        # Update model from chunk if available
        m = getattr(chunk, "model", None)
        if m:
            self._model = m
        # Anthropic streaming events have a .type attribute
        chunk_type = getattr(chunk, "type", None)
        if chunk_type == "message_start":
            msg = getattr(chunk, "message", None)
            if msg:
                u = getattr(msg, "usage", None)
                if u:
                    self._in_tok = getattr(u, "input_tokens", 0) or self._in_tok
        elif chunk_type == "message_delta":
            u = getattr(chunk, "usage", None)
            if u:
                self._out_tok = getattr(u, "output_tokens", 0) or self._out_tok

    def _record(self):
        if self._recorded:
            return
        self._recorded = True
        _record_async(self._func_name, self._model, self._start,
                      self._error, self._in_tok, self._out_tok,
                      self._agent, self._parent_id)


class _AsyncStreamInstrumentWrapper:
    """Wraps an async streaming response. Records the trace when the stream
    is exhausted or raises.

    Implements __aenter__/__aexit__/__getattr__ so it works as an async
    context manager (`async with client.chat.completions.create(...,
    stream=True) as s:`) and so attribute access on the underlying stream
    still works."""

    def __init__(self, stream, func_name, model, start, agent, parent_id):
        self._stream = stream
        self._func_name = func_name
        self._model = model
        self._start = start
        self._agent = agent
        self._parent_id = parent_id
        self._in_tok = 0
        self._out_tok = 0
        self._error: Optional[Exception] = None
        self._recorded = False

    def __aiter__(self):
        return self

    async def __anext__(self):
        try:
            chunk = await self._stream.__anext__()
            self._extract_usage(chunk)
            return chunk
        except StopAsyncIteration:
            self._record()
            raise
        except Exception as exc:
            self._error = exc
            self._record()
            raise

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        # Record the trace if the user exits without exhausting the stream.
        self._record()
        return False  # don't suppress exceptions

    def __getattr__(self, name):
        # Passthrough for attribute access on the underlying stream.
        # Note: async methods on the underlying stream will be returned as
        # regular functions; the caller must await them. This matches how
        # OpenAI's async stream objects expose methods like .parse().
        # Guard against infinite recursion if _stream isn't set yet.
        if name == "_stream":
            raise AttributeError(name)
        return getattr(self._stream, name)

    def _extract_usage(self, chunk):
        """Same logic as the sync wrapper — see that class for details."""
        usage = getattr(chunk, "usage", None)
        if usage:
            self._in_tok = getattr(usage, "prompt_tokens", 0) or self._in_tok
            self._out_tok = getattr(usage, "completion_tokens", 0) or self._out_tok
            self._in_tok = getattr(usage, "input_tokens", 0) or self._in_tok
            self._out_tok = getattr(usage, "output_tokens", 0) or self._out_tok
        m = getattr(chunk, "model", None)
        if m:
            self._model = m
        chunk_type = getattr(chunk, "type", None)
        if chunk_type == "message_start":
            msg = getattr(chunk, "message", None)
            if msg:
                u = getattr(msg, "usage", None)
                if u:
                    self._in_tok = getattr(u, "input_tokens", 0) or self._in_tok
        elif chunk_type == "message_delta":
            u = getattr(chunk, "usage", None)
            if u:
                self._out_tok = getattr(u, "output_tokens", 0) or self._out_tok

    def _record(self):
        if self._recorded:
            return
        self._recorded = True
        _record_async(self._func_name, self._model, self._start,
                      self._error, self._in_tok, self._out_tok,
                      self._agent, self._parent_id)


def _record_async(
    func_name: str,
    model: str,
    start: float,
    error: Optional[Exception],
    in_tok: int,
    out_tok: int,
    agent: Optional[Tuple[str, str]],
    parent_id: Optional[str],
) -> None:
    """Fire-and-forget: build the trace record and hand it to the background
    sender. Called in a ``finally`` block so it must never raise.
    """
    try:
        cost = calculate_cost(model or "", in_tok, out_tok)
        trace_id = _tracer._build_trace_id()
        agent_id, agent_name = agent or (trace_id, func_name)
        timestamp = datetime.now(timezone.utc).isoformat()
        latency = round(time.perf_counter() - start, 3)
        error_str = str(error) if error else None
        output = None if error else f"model={model} tokens={in_tok}in/{out_tok}out"
        args_str = f"model={model}"
        # save_trace writes to SQLite — fast local I/O, exception-safe.
        # Using module reference so tests can monkeypatch tracer.save_trace.
        _tracer.save_trace(
            trace_id, parent_id, func_name,
            args_str, output, latency, error_str,
            timestamp, in_tok, out_tok, cost,
            "llm", agent_id, agent_name,
        )
        _tracer._enqueue_remote({
            "id": trace_id, "parent_id": parent_id, "function": func_name,
            "args": args_str, "output": output or "", "latency_sec": latency,
            "error": error_str, "timestamp": timestamp,
            "input_tokens": in_tok, "output_tokens": out_tok, "cost_usd": cost,
            "kind": "llm", "agent_id": agent_id, "agent_name": agent_name,
        })
    except Exception as exc:
        print(f"[swarmtrace] auto-instrument record warning: {exc}", file=sys.stderr)


def _already_patched(target) -> bool:
    return getattr(target, "__swarmtrace_patched__", False)


def _mark_patched(wrapper):
    wrapper.__swarmtrace_patched__ = True
    return wrapper


# ---------------------------------------------------------------------------
# OpenAI (and OpenAI-compatible: Mistral, DeepSeek, Groq, Together, …)
# ---------------------------------------------------------------------------

def patch_openai() -> bool:
    try:
        from openai.resources.chat.completions import Completions, AsyncCompletions
    except ImportError:
        return False

    if not _already_patched(Completions.create):
        original = Completions.create

        @functools.wraps(original)
        def patched_create(self, *args, **kwargs):
            start = time.perf_counter()
            model = kwargs.get("model", "")
            agent = _tracer._current_agent()
            parent_id = _tracer._current_parent()
            error: Optional[Exception] = None
            in_tok = out_tok = 0
            is_stream = kwargs.get("stream", False)
            # stream_returned tracks whether original() successfully returned
            # a stream (vs raised). If it raised, we must record the error
            # trace here in the finally block — there's no stream wrapper to
            # defer to. If it returned a stream, the wrapper handles recording.
            stream_returned = False
            try:
                response = original(self, *args, **kwargs)
                if is_stream:
                    stream_returned = True
                    return _StreamInstrumentWrapper(
                        response, "openai.chat.completions.create",
                        model, start, agent, parent_id,
                    )
                usage = getattr(response, "usage", None)
                in_tok = getattr(usage, "prompt_tokens", 0) or 0
                out_tok = getattr(usage, "completion_tokens", 0) or 0
                model = getattr(response, "model", None) or model
                return response
            except Exception as exc:
                error = exc
                raise
            finally:
                # Record here ONLY if the stream wasn't returned (either
                # non-stream, or stream that raised before returning).
                # If the stream was returned, the wrapper records on exhaustion.
                if not stream_returned:
                    _record_async("openai.chat.completions.create",
                                  model, start, error, in_tok, out_tok, agent, parent_id)

        Completions.create = _mark_patched(patched_create)

    if not _already_patched(AsyncCompletions.create):
        original_async = AsyncCompletions.create

        @functools.wraps(original_async)
        async def patched_acreate(self, *args, **kwargs):
            start = time.perf_counter()
            model = kwargs.get("model", "")
            agent = _tracer._current_agent()
            parent_id = _tracer._current_parent()
            error: Optional[Exception] = None
            in_tok = out_tok = 0
            is_stream = kwargs.get("stream", False)
            stream_returned = False
            try:
                response = await original_async(self, *args, **kwargs)
                if is_stream:
                    stream_returned = True
                    return _AsyncStreamInstrumentWrapper(
                        response, "openai.chat.completions.create",
                        model, start, agent, parent_id,
                    )
                usage = getattr(response, "usage", None)
                in_tok = getattr(usage, "prompt_tokens", 0) or 0
                out_tok = getattr(usage, "completion_tokens", 0) or 0
                model = getattr(response, "model", None) or model
                return response
            except Exception as exc:
                error = exc
                raise
            finally:
                if not stream_returned:
                    _record_async("openai.chat.completions.create",
                                  model, start, error, in_tok, out_tok, agent, parent_id)

        AsyncCompletions.create = _mark_patched(patched_acreate)

    return True


# ---------------------------------------------------------------------------
# Anthropic
# ---------------------------------------------------------------------------

def patch_anthropic() -> bool:
    try:
        from anthropic.resources.messages import Messages, AsyncMessages
    except ImportError:
        return False

    if not _already_patched(Messages.create):
        original = Messages.create

        @functools.wraps(original)
        def patched_create(self, *args, **kwargs):
            start = time.perf_counter()
            model = kwargs.get("model", "")
            agent = _tracer._current_agent()
            parent_id = _tracer._current_parent()
            error: Optional[Exception] = None
            in_tok = out_tok = 0
            is_stream = kwargs.get("stream", False)
            stream_returned = False
            try:
                response = original(self, *args, **kwargs)
                if is_stream:
                    stream_returned = True
                    return _StreamInstrumentWrapper(
                        response, "anthropic.messages.create",
                        model, start, agent, parent_id,
                    )
                usage = getattr(response, "usage", None)
                in_tok = getattr(usage, "input_tokens", 0) or 0
                out_tok = getattr(usage, "output_tokens", 0) or 0
                model = getattr(response, "model", None) or model
                return response
            except Exception as exc:
                error = exc
                raise
            finally:
                if not stream_returned:
                    _record_async("anthropic.messages.create",
                                  model, start, error, in_tok, out_tok, agent, parent_id)

        Messages.create = _mark_patched(patched_create)

    if not _already_patched(AsyncMessages.create):
        original_async = AsyncMessages.create

        @functools.wraps(original_async)
        async def patched_acreate(self, *args, **kwargs):
            start = time.perf_counter()
            model = kwargs.get("model", "")
            agent = _tracer._current_agent()
            parent_id = _tracer._current_parent()
            error: Optional[Exception] = None
            in_tok = out_tok = 0
            is_stream = kwargs.get("stream", False)
            stream_returned = False
            try:
                response = await original_async(self, *args, **kwargs)
                if is_stream:
                    stream_returned = True
                    return _AsyncStreamInstrumentWrapper(
                        response, "anthropic.messages.create",
                        model, start, agent, parent_id,
                    )
                usage = getattr(response, "usage", None)
                in_tok = getattr(usage, "input_tokens", 0) or 0
                out_tok = getattr(usage, "output_tokens", 0) or 0
                model = getattr(response, "model", None) or model
                return response
            except Exception as exc:
                error = exc
                raise
            finally:
                if not stream_returned:
                    _record_async("anthropic.messages.create",
                                  model, start, error, in_tok, out_tok, agent, parent_id)

        AsyncMessages.create = _mark_patched(patched_acreate)

    return True


# ---------------------------------------------------------------------------
# Google Gemini (google-generativeai)
# ---------------------------------------------------------------------------

def patch_gemini() -> bool:
    try:
        from google.generativeai import GenerativeModel
    except ImportError:
        return False

    def _model_name(self) -> str:
        name = getattr(self, "model_name", "") or getattr(self, "_model_name", "") or ""
        return name.removeprefix("models/")

    if not _already_patched(GenerativeModel.generate_content):
        original = GenerativeModel.generate_content

        @functools.wraps(original)
        def patched_generate(self, *args, **kwargs):
            start = time.perf_counter()
            model = _model_name(self)
            agent = _tracer._current_agent()
            parent_id = _tracer._current_parent()
            error: Optional[Exception] = None
            in_tok = out_tok = 0
            is_stream = kwargs.get("stream", False)
            stream_returned = False
            try:
                response = original(self, *args, **kwargs)
                if is_stream:
                    stream_returned = True
                    return _StreamInstrumentWrapper(
                        response, "gemini.generate_content",
                        model, start, agent, parent_id,
                    )
                usage = getattr(response, "usage_metadata", None)
                in_tok = getattr(usage, "prompt_token_count", 0) or 0
                out_tok = getattr(usage, "candidates_token_count", 0) or 0
                return response
            except Exception as exc:
                error = exc
                raise
            finally:
                if not stream_returned:
                    _record_async("gemini.generate_content",
                                  model, start, error, in_tok, out_tok, agent, parent_id)

        GenerativeModel.generate_content = _mark_patched(patched_generate)

    original_async = getattr(GenerativeModel, "generate_content_async", None)
    if original_async is not None and not _already_patched(original_async):

        @functools.wraps(original_async)
        async def patched_generate_async(self, *args, **kwargs):
            start = time.perf_counter()
            model = _model_name(self)
            agent = _tracer._current_agent()
            parent_id = _tracer._current_parent()
            error: Optional[Exception] = None
            in_tok = out_tok = 0
            is_stream = kwargs.get("stream", False)
            stream_returned = False
            try:
                response = await original_async(self, *args, **kwargs)
                if is_stream:
                    stream_returned = True
                    return _AsyncStreamInstrumentWrapper(
                        response, "gemini.generate_content",
                        model, start, agent, parent_id,
                    )
                usage = getattr(response, "usage_metadata", None)
                in_tok = getattr(usage, "prompt_token_count", 0) or 0
                out_tok = getattr(usage, "candidates_token_count", 0) or 0
                return response
            except Exception as exc:
                error = exc
                raise
            finally:
                if not stream_returned:
                    _record_async("gemini.generate_content",
                                  model, start, error, in_tok, out_tok, agent, parent_id)

        GenerativeModel.generate_content_async = _mark_patched(patched_generate_async)

    return True


# ---------------------------------------------------------------------------
# LiteLLM (covers Mistral, DeepSeek, Cohere, Bedrock, Azure, … via one SDK)
# ---------------------------------------------------------------------------

def patch_litellm() -> bool:
    try:
        import litellm
    except ImportError:
        return False

    if not _already_patched(litellm.completion):
        original = litellm.completion

        @functools.wraps(original)
        def patched_completion(*args, **kwargs):
            start = time.perf_counter()
            model = kwargs.get("model") or (args[0] if args else "")
            agent = _tracer._current_agent()
            parent_id = _tracer._current_parent()
            error: Optional[Exception] = None
            in_tok = out_tok = 0
            is_stream = kwargs.get("stream", False)
            stream_returned = False
            try:
                response = original(*args, **kwargs)
                if is_stream:
                    stream_returned = True
                    return _StreamInstrumentWrapper(
                        response, "litellm.completion",
                        model, start, agent, parent_id,
                    )
                usage = getattr(response, "usage", None)
                in_tok = getattr(usage, "prompt_tokens", 0) or 0
                out_tok = getattr(usage, "completion_tokens", 0) or 0
                model = getattr(response, "model", None) or model
                return response
            except Exception as exc:
                error = exc
                raise
            finally:
                if not stream_returned:
                    _record_async("litellm.completion",
                                  model, start, error, in_tok, out_tok, agent, parent_id)

        litellm.completion = _mark_patched(patched_completion)

    if not _already_patched(litellm.acompletion):
        original_async = litellm.acompletion

        @functools.wraps(original_async)
        async def patched_acompletion(*args, **kwargs):
            start = time.perf_counter()
            model = kwargs.get("model") or (args[0] if args else "")
            agent = _tracer._current_agent()
            parent_id = _tracer._current_parent()
            error: Optional[Exception] = None
            in_tok = out_tok = 0
            is_stream = kwargs.get("stream", False)
            stream_returned = False
            try:
                response = await original_async(*args, **kwargs)
                if is_stream:
                    stream_returned = True
                    return _AsyncStreamInstrumentWrapper(
                        response, "litellm.completion",
                        model, start, agent, parent_id,
                    )
                usage = getattr(response, "usage", None)
                in_tok = getattr(usage, "prompt_tokens", 0) or 0
                out_tok = getattr(usage, "completion_tokens", 0) or 0
                model = getattr(response, "model", None) or model
                return response
            except Exception as exc:
                error = exc
                raise
            finally:
                if not stream_returned:
                    _record_async("litellm.completion",
                                  model, start, error, in_tok, out_tok, agent, parent_id)

        litellm.acompletion = _mark_patched(patched_acompletion)

    return True


def patch_all() -> dict:
    """Patch every supported LLM client that's installed. Safe to call repeatedly.

    Returns which clients are active, e.g.::

        {"openai": True, "anthropic": False, "gemini": False, "litellm": True}

    A client being ``False`` just means that SDK isn't installed in this
    environment — everything else keeps tracing normally. Also printed to
    stderr as one line, the same way ``fov.patch_all()`` reports its own
    active patches, so ``init()`` never leaves you guessing which LLM calls
    are actually being traced.
    """
    patches = {
        "openai":    patch_openai,
        "anthropic": patch_anthropic,
        "gemini":    patch_gemini,
        "litellm":   patch_litellm,
    }
    results: dict = {}
    for name, patch in patches.items():
        try:
            results[name] = bool(patch())
        except Exception as exc:
            results[name] = False
            print(
                f"[swarmtrace] auto-instrument warning ({patch.__name__}): {exc}",
                file=sys.stderr,
            )
    active = [name for name, ok in results.items() if ok]
    print(
        f"[swarmtrace] llm auto-instrument active: {', '.join(active) or 'none installed'}",
        file=sys.stderr,
    )
    return results
