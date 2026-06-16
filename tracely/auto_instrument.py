"""
Optional auto-instrumentation for popular LLM client libraries.

``tracely.init()`` (default ``auto_instrument=True``) calls :func:`patch_all`,
which patches whichever of OpenAI, Anthropic, Gemini, and LiteLLM are
installed, so raw LLM calls are traced as ``kind="llm"`` — attributed to
whatever ``@observe``'d agent is currently running, or to themselves if
none — with zero decorators at the call site::

    import tracely
    tracely.init()

    client = OpenAI()

    @tracely.observe
    def my_agent(prompt):
        return client.chat.completions.create(   # traced automatically
            model="gpt-4o-mini",
            messages=[{"role": "user", "content": prompt}],
        )

Each patch:

- is a no-op if that library isn't installed
- is idempotent — safe to call ``patch_all()`` repeatedly (e.g. from
  multiple ``init()`` calls); each client is only wrapped once
- records latency, model, token usage, and cost (via the live pricing table
  in :mod:`tracely.pricing`) on both success and error
- records ONLY that metadata — never prompt/response content. Auto-
  instrumentation shouldn't silently start persisting the user's prompts;
  if you want full input/output captured, wrap the call yourself with
  ``@observe(kind="llm")`` instead
- never changes return values or swallows exceptions from the wrapped call

Streaming responses (``stream=True``) are still traced (latency + model +
error), but token usage isn't available until the stream is consumed, so
``input_tokens``/``output_tokens``/``cost_usd`` are recorded as 0 for those.
"""

import functools
import sys
import time
from datetime import datetime, timezone

from tracely.pricing import calculate_cost
from tracely.tracer import _build_trace_id, _current_agent, _current_parent, _safe_flush


def _record(func_name: str, model: str, start: float, error, in_tok: int, out_tok: int) -> None:
    cost = calculate_cost(model or "", in_tok, out_tok)
    agent_id, agent_name = _current_agent() or (None, None)
    _safe_flush(
        _build_trace_id(),
        _current_parent(),
        func_name,
        (model,), {},
        None if error else f"model={model} tokens={in_tok}in/{out_tok}out",
        round(time.perf_counter() - start, 3),
        str(error) if error else None,
        datetime.now(timezone.utc).isoformat(),
        in_tok, out_tok, cost,
        "llm", agent_id, agent_name,
    )


def _already_patched(target) -> bool:
    return getattr(target, "__tracely_patched__", False)


def _mark_patched(wrapper):
    wrapper.__tracely_patched__ = True
    return wrapper


# ---------------------------------------------------------------------------
# OpenAI (and OpenAI-compatible clients using the official `openai` package
# with a custom base_url — Mistral, DeepSeek, Groq, Together, etc.)
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
            try:
                response = original(self, *args, **kwargs)
                usage = getattr(response, "usage", None)
                in_tok = getattr(usage, "prompt_tokens", 0) or 0
                out_tok = getattr(usage, "completion_tokens", 0) or 0
                _record("openai.chat.completions.create",
                        getattr(response, "model", None) or model, start, None, in_tok, out_tok)
                return response
            except Exception as exc:
                _record("openai.chat.completions.create", model, start, exc, 0, 0)
                raise

        Completions.create = _mark_patched(patched_create)

    if not _already_patched(AsyncCompletions.create):
        original_async = AsyncCompletions.create

        @functools.wraps(original_async)
        async def patched_acreate(self, *args, **kwargs):
            start = time.perf_counter()
            model = kwargs.get("model", "")
            try:
                response = await original_async(self, *args, **kwargs)
                usage = getattr(response, "usage", None)
                in_tok = getattr(usage, "prompt_tokens", 0) or 0
                out_tok = getattr(usage, "completion_tokens", 0) or 0
                _record("openai.chat.completions.create",
                        getattr(response, "model", None) or model, start, None, in_tok, out_tok)
                return response
            except Exception as exc:
                _record("openai.chat.completions.create", model, start, exc, 0, 0)
                raise

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
            try:
                response = original(self, *args, **kwargs)
                usage = getattr(response, "usage", None)
                in_tok = getattr(usage, "input_tokens", 0) or 0
                out_tok = getattr(usage, "output_tokens", 0) or 0
                _record("anthropic.messages.create",
                        getattr(response, "model", None) or model, start, None, in_tok, out_tok)
                return response
            except Exception as exc:
                _record("anthropic.messages.create", model, start, exc, 0, 0)
                raise

        Messages.create = _mark_patched(patched_create)

    if not _already_patched(AsyncMessages.create):
        original_async = AsyncMessages.create

        @functools.wraps(original_async)
        async def patched_acreate(self, *args, **kwargs):
            start = time.perf_counter()
            model = kwargs.get("model", "")
            try:
                response = await original_async(self, *args, **kwargs)
                usage = getattr(response, "usage", None)
                in_tok = getattr(usage, "input_tokens", 0) or 0
                out_tok = getattr(usage, "output_tokens", 0) or 0
                _record("anthropic.messages.create",
                        getattr(response, "model", None) or model, start, None, in_tok, out_tok)
                return response
            except Exception as exc:
                _record("anthropic.messages.create", model, start, exc, 0, 0)
                raise

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
            try:
                response = original(self, *args, **kwargs)
                usage = getattr(response, "usage_metadata", None)
                in_tok = getattr(usage, "prompt_token_count", 0) or 0
                out_tok = getattr(usage, "candidates_token_count", 0) or 0
                _record("gemini.generate_content", model, start, None, in_tok, out_tok)
                return response
            except Exception as exc:
                _record("gemini.generate_content", model, start, exc, 0, 0)
                raise

        GenerativeModel.generate_content = _mark_patched(patched_generate)

    original_async = getattr(GenerativeModel, "generate_content_async", None)
    if original_async is not None and not _already_patched(original_async):

        @functools.wraps(original_async)
        async def patched_generate_async(self, *args, **kwargs):
            start = time.perf_counter()
            model = _model_name(self)
            try:
                response = await original_async(self, *args, **kwargs)
                usage = getattr(response, "usage_metadata", None)
                in_tok = getattr(usage, "prompt_token_count", 0) or 0
                out_tok = getattr(usage, "candidates_token_count", 0) or 0
                _record("gemini.generate_content", model, start, None, in_tok, out_tok)
                return response
            except Exception as exc:
                _record("gemini.generate_content", model, start, exc, 0, 0)
                raise

        GenerativeModel.generate_content_async = _mark_patched(patched_generate_async)


# ---------------------------------------------------------------------------
# LiteLLM — module-level completion()/acompletion(), covers many providers
# (Mistral, DeepSeek, Cohere, Bedrock, Azure, ...) through one integration.
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
            try:
                response = original(*args, **kwargs)
                usage = getattr(response, "usage", None)
                in_tok = getattr(usage, "prompt_tokens", 0) or 0
                out_tok = getattr(usage, "completion_tokens", 0) or 0
                _record("litellm.completion",
                        getattr(response, "model", None) or model, start, None, in_tok, out_tok)
                return response
            except Exception as exc:
                _record("litellm.completion", model, start, exc, 0, 0)
                raise

        litellm.completion = _mark_patched(patched_completion)

    if not _already_patched(litellm.acompletion):
        original_async = litellm.acompletion

        @functools.wraps(original_async)
        async def patched_acompletion(*args, **kwargs):
            start = time.perf_counter()
            model = kwargs.get("model") or (args[0] if args else "")
            try:
                response = await original_async(*args, **kwargs)
                usage = getattr(response, "usage", None)
                in_tok = getattr(usage, "prompt_tokens", 0) or 0
                out_tok = getattr(usage, "completion_tokens", 0) or 0
                _record("litellm.completion",
                        getattr(response, "model", None) or model, start, None, in_tok, out_tok)
                return response
            except Exception as exc:
                _record("litellm.completion", model, start, exc, 0, 0)
                raise

        litellm.acompletion = _mark_patched(patched_acompletion)


def patch_all() -> None:
    """Patch every supported LLM client that's installed. Safe to call repeatedly."""
    for patch in (patch_openai, patch_anthropic, patch_gemini, patch_litellm):
        try:
            patch()
        except Exception as exc:
            print(f"[swarmtrace] auto-instrument warning ({patch.__name__}): {exc}", file=sys.stderr)
