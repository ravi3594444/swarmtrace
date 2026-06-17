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

def patch_openai() -> None:
    try:
        from openai.resources.chat.completions import Completions, AsyncCompletions
    except ImportError:
        return

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
            try:
                response = original(self, *args, **kwargs)
                usage = getattr(response, "usage", None)
                in_tok = getattr(usage, "prompt_tokens", 0) or 0
                out_tok = getattr(usage, "completion_tokens", 0) or 0
                model = getattr(response, "model", None) or model
                return response
            except Exception as exc:
                error = exc
                raise
            finally:
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
            try:
                response = await original_async(self, *args, **kwargs)
                usage = getattr(response, "usage", None)
                in_tok = getattr(usage, "prompt_tokens", 0) or 0
                out_tok = getattr(usage, "completion_tokens", 0) or 0
                model = getattr(response, "model", None) or model
                return response
            except Exception as exc:
                error = exc
                raise
            finally:
                _record_async("openai.chat.completions.create",
                              model, start, error, in_tok, out_tok, agent, parent_id)

        AsyncCompletions.create = _mark_patched(patched_acreate)


# ---------------------------------------------------------------------------
# Anthropic
# ---------------------------------------------------------------------------

def patch_anthropic() -> None:
    try:
        from anthropic.resources.messages import Messages, AsyncMessages
    except ImportError:
        return

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
            try:
                response = original(self, *args, **kwargs)
                usage = getattr(response, "usage", None)
                in_tok = getattr(usage, "input_tokens", 0) or 0
                out_tok = getattr(usage, "output_tokens", 0) or 0
                model = getattr(response, "model", None) or model
                return response
            except Exception as exc:
                error = exc
                raise
            finally:
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
            try:
                response = await original_async(self, *args, **kwargs)
                usage = getattr(response, "usage", None)
                in_tok = getattr(usage, "input_tokens", 0) or 0
                out_tok = getattr(usage, "output_tokens", 0) or 0
                model = getattr(response, "model", None) or model
                return response
            except Exception as exc:
                error = exc
                raise
            finally:
                _record_async("anthropic.messages.create",
                              model, start, error, in_tok, out_tok, agent, parent_id)

        AsyncMessages.create = _mark_patched(patched_acreate)


# ---------------------------------------------------------------------------
# Google Gemini (google-generativeai)
# ---------------------------------------------------------------------------

def patch_gemini() -> None:
    try:
        from google.generativeai import GenerativeModel
    except ImportError:
        return

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
            try:
                response = original(self, *args, **kwargs)
                usage = getattr(response, "usage_metadata", None)
                in_tok = getattr(usage, "prompt_token_count", 0) or 0
                out_tok = getattr(usage, "candidates_token_count", 0) or 0
                return response
            except Exception as exc:
                error = exc
                raise
            finally:
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
            try:
                response = await original_async(self, *args, **kwargs)
                usage = getattr(response, "usage_metadata", None)
                in_tok = getattr(usage, "prompt_token_count", 0) or 0
                out_tok = getattr(usage, "candidates_token_count", 0) or 0
                return response
            except Exception as exc:
                error = exc
                raise
            finally:
                _record_async("gemini.generate_content",
                              model, start, error, in_tok, out_tok, agent, parent_id)

        GenerativeModel.generate_content_async = _mark_patched(patched_generate_async)


# ---------------------------------------------------------------------------
# LiteLLM (covers Mistral, DeepSeek, Cohere, Bedrock, Azure, … via one SDK)
# ---------------------------------------------------------------------------

def patch_litellm() -> None:
    try:
        import litellm
    except ImportError:
        return

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
            try:
                response = original(*args, **kwargs)
                usage = getattr(response, "usage", None)
                in_tok = getattr(usage, "prompt_tokens", 0) or 0
                out_tok = getattr(usage, "completion_tokens", 0) or 0
                model = getattr(response, "model", None) or model
                return response
            except Exception as exc:
                error = exc
                raise
            finally:
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
            try:
                response = await original_async(*args, **kwargs)
                usage = getattr(response, "usage", None)
                in_tok = getattr(usage, "prompt_tokens", 0) or 0
                out_tok = getattr(usage, "completion_tokens", 0) or 0
                model = getattr(response, "model", None) or model
                return response
            except Exception as exc:
                error = exc
                raise
            finally:
                _record_async("litellm.completion",
                              model, start, error, in_tok, out_tok, agent, parent_id)

        litellm.acompletion = _mark_patched(patched_acompletion)


def patch_all() -> None:
    """Patch every supported LLM client that's installed. Safe to call repeatedly."""
    for patch in (patch_openai, patch_anthropic, patch_gemini, patch_litellm):
        try:
            patch()
        except Exception as exc:
            print(
                f"[swarmtrace] auto-instrument warning ({patch.__name__}): {exc}",
                file=sys.stderr,
            )
