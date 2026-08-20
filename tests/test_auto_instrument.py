"""Tests for auto-instrumentation of OpenAI / Anthropic / Gemini / LiteLLM.

OpenAI and Anthropic are real installed SDKs here, so the response objects
match production shapes exactly. Gemini and LiteLLM are exercised via fake
modules injected into sys.modules — patch_gemini()/patch_litellm() are
no-ops if those packages aren't installed, so this is the only way to test
the wrapping logic without adding heavy optional dependencies to the test
environment.
"""

import asyncio
import sys
import types

import pytest

import swarmtrace.auto_instrument as ai
from swarmtrace import tracer

_SAVE_TRACE_FIELD_ORDER = (
    "id_", "parent_id", "function", "args", "output", "latency_sec",
    "error", "timestamp", "input_tokens", "output_tokens", "cost_usd",
    "kind", "agent_id", "agent_name", "session_id",
)


@pytest.fixture()
def records(monkeypatch, fake_runtime):
    """Capture spans through the Phase 1 runtime seam instead of patching
    tracer.save_trace. The tuple shape is preserved so every existing
    row[N] / row[-N] assertion keeps working unchanged.
    """
    saved = []

    def _capture(span):
        fake_runtime.repository.spans.append(span)
        saved.append((
            span.span_id, span.parent_span_id, span.name, span.args, span.output,
            span.latency_sec, span.error, span.start_time.isoformat(),
            span.input_tokens, span.output_tokens, span.cost_usd,
            span.kind, span.agent_id, span.agent_name, span.session_id,
        ))

    monkeypatch.setattr(fake_runtime.repository, "save", _capture)
    return saved


# ---------------------------------------------------------------------------
# OpenAI
# ---------------------------------------------------------------------------

def _has_openai() -> bool:
    try:
        import openai  # noqa: F401 -- presence check only
        return True
    except Exception:  # noqa: BLE001 -- optional-dependency presence check, any failure means "not installed"
        return False


def _fake_chat_completion(model="gpt-4o-mini", prompt_tokens=10, completion_tokens=5):
    from openai.types.chat import ChatCompletion
    from openai.types.chat.chat_completion import Choice
    from openai.types.chat.chat_completion_message import ChatCompletionMessage
    from openai.types.completion_usage import CompletionUsage

    return ChatCompletion(
        id="chatcmpl-test",
        object="chat.completion",
        created=0,
        model=model,
        choices=[Choice(
            finish_reason="stop", index=0,
            message=ChatCompletionMessage(role="assistant", content="hi"),
        )],
        usage=CompletionUsage(
            prompt_tokens=prompt_tokens, completion_tokens=completion_tokens,
            total_tokens=prompt_tokens + completion_tokens,
        ),
    )


@pytest.mark.skipif(
    not _has_openai(),
    reason="openai package not installed",
)
def test_patch_openai_records_llm_trace_attributed_to_enclosing_agent(records, monkeypatch):
    from openai import OpenAI
    from openai.resources.chat.completions import Completions

    response = _fake_chat_completion()
    monkeypatch.setattr(Completions, "create", lambda self, **kw: response)

    ai.patch_openai()
    assert Completions.create.__swarmtrace_patched__ is True

    client = OpenAI(api_key="test")

    @tracer.observe
    def my_agent():
        return client.chat.completions.create(
            model="gpt-4o-mini", messages=[{"role": "user", "content": "hi"}]
        )

    my_agent()

    by_func = {r[2]: r for r in records}
    agent_id = by_func["my_agent"][-3]
    llm_row = by_func["openai.chat.completions.create"]

    assert llm_row[-4:-1] == ("llm", agent_id, "my_agent")
    assert llm_row[8] == 10  # input_tokens
    assert llm_row[9] == 5   # output_tokens
    assert llm_row[10] > 0   # cost computed from a real model name


@pytest.mark.skipif(
    not _has_openai(),
    reason="openai package not installed",
)
def test_patch_openai_is_idempotent(records, monkeypatch):
    from openai import OpenAI
    from openai.resources.chat.completions import Completions

    response = _fake_chat_completion()
    calls = []

    def fake_create(self, **kw):
        calls.append(kw)
        return response

    monkeypatch.setattr(Completions, "create", fake_create)
    ai.patch_openai()
    ai.patch_openai()  # second call must not double-wrap

    client = OpenAI(api_key="test")
    client.chat.completions.create(model="gpt-4o-mini", messages=[])

    assert len(calls) == 1     # original invoked exactly once
    assert len(records) == 1   # exactly one trace recorded, not double


@pytest.mark.skipif(
    not _has_openai(),
    reason="openai package not installed",
)
def test_patch_openai_records_error_with_zero_tokens(records, monkeypatch):
    from openai import OpenAI
    from openai.resources.chat.completions import Completions

    def boom(self, **kw):
        raise RuntimeError("rate limited")

    monkeypatch.setattr(Completions, "create", boom)
    ai.patch_openai()

    client = OpenAI(api_key="test")

    with pytest.raises(RuntimeError):
        client.chat.completions.create(model="gpt-4o-mini", messages=[])

    assert len(records) == 1
    row = records[0]
    assert row[2] == "openai.chat.completions.create"
    assert row[6] == "rate limited"  # error
    assert row[8] == 0 and row[9] == 0
    assert row[-4] == "llm"


@pytest.mark.skipif(
    not _has_openai(),
    reason="openai package not installed",
)
def test_patch_openai_redacts_api_key_in_error_message(records, monkeypatch):
    """LLM auth errors can echo the API key back in the exception message.
    The auto-instrument path must redact it before saving/enqueuing —
    this is the PII leak that the original Task 1 commit missed because
    the args_str/output strings are synthesized ("model=…") and don't
    carry user content, but the error string DOES (it comes from the
    provider's exception, which we don't control)."""
    from openai import OpenAI
    from openai.resources.chat.completions import Completions

    fake_key = "sk-ant-" + "X" * 50
    # Simulate an auth error that echoes the key (a real failure mode
    # for some older OpenAI client versions and Anthropic error shapes).
    def boom(self, **kw):
        raise RuntimeError(
            f"AuthenticationError: invalid api key '{fake_key}' (status 401)"
        )

    monkeypatch.setattr(Completions, "create", boom)
    ai.patch_openai()

    client = OpenAI(api_key="test")
    with pytest.raises(RuntimeError):
        client.chat.completions.create(model="gpt-4o-mini", messages=[])

    assert len(records) == 1
    row = records[0]
    error_str = row[6]  # error column
    # The API key must NOT appear in the stored error string.
    assert fake_key not in error_str, (
        f"API key leaked into stored error: {error_str!r}"
    )
    assert "[REDACTED]" in error_str, (
        f"Expected [REDACTED] marker, got: {error_str!r}"
    )
    # The non-PII part of the error message is preserved.
    assert "AuthenticationError" in error_str


# ---------------------------------------------------------------------------
# Anthropic
# ---------------------------------------------------------------------------

def _has_anthropic() -> bool:
    try:
        import anthropic  # noqa: F401 -- presence check only
        return True
    except Exception:  # noqa: BLE001 -- optional-dependency presence check, any failure means "not installed"
        return False



def _fake_message(model="claude-3-haiku-20240307", input_tokens=7, output_tokens=12):
    from anthropic.types import Message, Usage

    return Message(
        id="msg-test",
        type="message",
        role="assistant",
        model=model,
        content=[],
        stop_reason="end_turn",
        usage=Usage(input_tokens=input_tokens, output_tokens=output_tokens),
    )


@pytest.mark.skipif(
    not _has_anthropic(),
    reason="anthropic package not installed",
)
def test_patch_anthropic_records_llm_trace(records, monkeypatch):
    from anthropic import Anthropic
    from anthropic.resources.messages import Messages

    response = _fake_message()
    monkeypatch.setattr(Messages, "create", lambda self, **kw: response)

    ai.patch_anthropic()

    client = Anthropic(api_key="test")

    @tracer.observe
    def my_agent():
        return client.messages.create(
            model="claude-3-haiku-20240307", max_tokens=10, messages=[]
        )

    my_agent()

    by_func = {r[2]: r for r in records}
    agent_id = by_func["my_agent"][-3]
    llm_row = by_func["anthropic.messages.create"]

    assert llm_row[-4:-1] == ("llm", agent_id, "my_agent")
    assert llm_row[8] == 7
    assert llm_row[9] == 12


# ---------------------------------------------------------------------------
# Gemini (google-generativeai) — injected fake module, since the real
# package isn't installed in this environment.
# ---------------------------------------------------------------------------

@pytest.fixture()
def fake_genai(monkeypatch):
    google_pkg = types.ModuleType("google")
    google_pkg.__path__ = []  # mark as a package so submodule import resolves
    genai_pkg = types.ModuleType("google.generativeai")

    class FakeUsage:
        def __init__(self, p, c):
            self.prompt_token_count = p
            self.candidates_token_count = c

    class FakeResponse:
        def __init__(self, p, c):
            self.usage_metadata = FakeUsage(p, c)

    class GenerativeModel:
        def __init__(self, model_name):
            self.model_name = model_name

        def generate_content(self, prompt):
            return FakeResponse(8, 16)

        async def generate_content_async(self, prompt):
            return FakeResponse(8, 16)

    genai_pkg.GenerativeModel = GenerativeModel
    google_pkg.generativeai = genai_pkg
    monkeypatch.setitem(sys.modules, "google", google_pkg)
    monkeypatch.setitem(sys.modules, "google.generativeai", genai_pkg)
    return genai_pkg


def test_patch_gemini_sync_records_llm_trace(records, fake_genai):
    ai.patch_gemini()

    model = fake_genai.GenerativeModel("models/gemini-2.0-flash")

    @tracer.observe
    def my_agent():
        return model.generate_content("hi")

    my_agent()

    by_func = {r[2]: r for r in records}
    agent_id = by_func["my_agent"][-3]
    llm_row = by_func["gemini.generate_content"]

    assert llm_row[-4:-1] == ("llm", agent_id, "my_agent")
    assert llm_row[8] == 8
    assert llm_row[9] == 16
    # "models/" prefix stripped before being stored/used for pricing
    assert llm_row[3] == "model=gemini-2.0-flash"


def test_patch_gemini_async_records_llm_trace(records, fake_genai):
    ai.patch_gemini()

    model = fake_genai.GenerativeModel("models/gemini-2.0-flash")

    @tracer.observe
    async def my_agent():
        return await model.generate_content_async("hi")

    asyncio.run(my_agent())

    by_func = {r[2]: r for r in records}
    agent_id = by_func["my_agent"][-3]
    llm_row = by_func["gemini.generate_content"]

    assert llm_row[-4:-1] == ("llm", agent_id, "my_agent")
    assert llm_row[8] == 8
    assert llm_row[9] == 16


# ---------------------------------------------------------------------------
# LiteLLM — injected fake module, since the real package isn't installed.
# ---------------------------------------------------------------------------

@pytest.fixture()
def fake_litellm(monkeypatch):
    litellm_pkg = types.ModuleType("litellm")

    class FakeUsage:
        prompt_tokens = 3
        completion_tokens = 4

    class FakeResponse:
        model = "mistral/mistral-small"
        usage = FakeUsage()

    def completion(*args, **kwargs):
        return FakeResponse()

    async def acompletion(*args, **kwargs):
        return FakeResponse()

    litellm_pkg.completion = completion
    litellm_pkg.acompletion = acompletion
    monkeypatch.setitem(sys.modules, "litellm", litellm_pkg)
    return litellm_pkg


def test_patch_litellm_records_llm_trace(records, fake_litellm):
    ai.patch_litellm()
    import litellm

    @tracer.observe
    def my_agent():
        return litellm.completion(model="mistral/mistral-small", messages=[])

    my_agent()

    by_func = {r[2]: r for r in records}
    agent_id = by_func["my_agent"][-3]
    llm_row = by_func["litellm.completion"]

    assert llm_row[-4:-1] == ("llm", agent_id, "my_agent")
    assert llm_row[8] == 3
    assert llm_row[9] == 4


# ---------------------------------------------------------------------------
# patch_all() / init()
# ---------------------------------------------------------------------------

def test_patch_all_does_not_raise(records):
    ai.patch_all()


def test_init_default_runs_auto_instrument(monkeypatch):
    called = []
    monkeypatch.setattr(ai, "patch_all", lambda: called.append(True))
    tracer.init()
    assert called == [True]


def test_init_auto_instrument_false_skips_patching(monkeypatch):
    called = []
    monkeypatch.setattr(ai, "patch_all", lambda: called.append(True))
    tracer.init(auto_instrument=False)
    assert called == []
