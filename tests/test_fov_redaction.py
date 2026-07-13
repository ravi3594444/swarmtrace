"""Regression tests for FOV credential redaction.

Bug: when FOV tracing was enabled, the Playwright method wrapper in
fov.py recorded every positional argument verbatim — including the
VALUE arg of fill()/type()/press()/select_option(). So code like::

    page.fill("#password", "CorrectHorseBatteryStaple!")

produced a browser 'started' event with the password stored verbatim,
which was then persisted to local SQLite, queued for remote /api/events
ingest, and stored in Supabase — all without any redaction.

Fix (reviewer P1): ALWAYS redact the value arg of fill/type/press/
select_option, regardless of the selector. The first implementation
only redacted when the selector matched a keyword (password|token|...),
but generic selectors like 'input:nth-of-type(2)' or '#field-2' don't
contain those keywords — so the password leaked. The only safe default
is to redact every fill/type value and record only the length for
debugging: [REDACTED(len=N)].

Also: goto() URL args are passed through _redact_url() to strip query
strings and fragments (which carry session tokens, OAuth codes, API
keys, reset tokens). HTTP events (requests/httpx) get the same URL
redaction. Browser exceptions contextually remove submitted values, and LLM
stream events retain only character-count metadata so split secrets cannot be
reassembled from earlier chunks.
"""

from __future__ import annotations

import swarmtrace.fov as fov


# ---------------------------------------------------------------------------
# Value-method redaction — ALWAYS redact fill/type/press/select_option values
# ---------------------------------------------------------------------------

def test_fill_password_value_is_redacted():
    """The exact reproduction from the security report: page.fill('#password',
    'CorrectHorseBatteryStaple!') must NOT persist the password."""
    out = fov._redact_browser_args("fill", ("#password", "CorrectHorseBatteryStaple!"))
    assert out[0] == "#password"
    assert "CorrectHorseBatteryStaple" not in out[1]
    assert out[1] == "[REDACTED(len=26)]"


def test_type_password_value_is_redacted():
    """type() is also a value method — same redaction."""
    out = fov._redact_browser_args("type", ("#password", "hunter2"))
    assert out[1] == "[REDACTED(len=7)]"


def test_fill_generic_selector_still_redacts_value():
    """Reviewer P1 fix: generic selectors like 'input:nth-of-type(2)' don't
    contain password/token/secret keywords. The first implementation only
    redacted when the selector matched a keyword, leaking the value. Now
    we ALWAYS redact fill/type values regardless of the selector."""
    out = fov._redact_browser_args("fill", ("input:nth-of-type(2)", "CorrectHorseBatteryStaple!"))
    assert out[0] == "input:nth-of-type(2)"
    assert "CorrectHorseBatteryStaple" not in out[1]
    assert out[1] == "[REDACTED(len=26)]"


def test_fill_field_2_selector_still_redacts_value():
    """Another generic selector that doesn't match any keyword."""
    out = fov._redact_browser_args("fill", ("#field-2", "my-secret-password"))
    assert out[0] == "#field-2"
    assert "my-secret-password" not in out[1]


def test_fill_login_input_selector_still_redacts_value():
    """'.login-input' — common in generated apps, doesn't match keywords."""
    out = fov._redact_browser_args("fill", (".login-input", "p@ssw0rd123"))
    assert "p@ssw0rd123" not in out[1]


def test_fill_token_selector_redacts_value():
    out = fov._redact_browser_args("fill", ('input[name="user_token"]', "tok_xyz_abc"))
    assert out[0] == 'input[name="user_token"]'
    assert "tok_xyz_abc" not in out[1]


def test_fill_secret_selector_redacts_value():
    out = fov._redact_browser_args("fill", ("#client_secret", "super-secret-value"))
    assert "super-secret-value" not in out[1]


def test_fill_apikey_selector_redacts_value():
    for sel in ("#api_key", "#api-key", "#apiKey"):
        out = fov._redact_browser_args("fill", (sel, "AIzaSyA" + "a" * 35))
        assert "AIzaSyA" not in out[1], f"selector {sel!r} did not trigger redaction: {out}"


def test_fill_auth_cookie_session_selectors_redact_value():
    for sel in ("#auth_token", "#authorization", "#session_cookie", "#csrf_session"):
        out = fov._redact_browser_args("fill", (sel, "some-value"))
        assert "some-value" not in out[1], f"selector {sel!r} did not trigger redaction: {out}"


def test_fill_non_sensitive_field_also_redacts_value():
    """Reviewer P1 fix: we now redact ALL fill/type values, not just sensitive
    ones. Even '#username' and '#search' get redacted — the value length is
    recorded for debugging, but the actual value is never persisted. This
    is the safe default since we can't reliably detect which fields are
    sensitive from the selector alone."""
    out = fov._redact_browser_args("fill", ("#username", "ravi"))
    assert out[0] == "#username"
    assert "ravi" not in out[1]
    assert out[1] == "[REDACTED(len=4)]"

    out = fov._redact_browser_args("fill", ("#search", "hello world"))
    assert "hello world" not in out[1]
    assert out[1] == "[REDACTED(len=11)]"


def test_click_is_not_value_redacted():
    """click() is not in _VALUE_METHODS — its args pass through (subject
    only to pattern-based redaction, which doesn't match a bare selector)."""
    out = fov._redact_browser_args("click", ("#submit",))
    assert out == ["#submit"]


def test_select_option_value_redacted():
    out = fov._redact_browser_args("select_option", ("#security_question", "my_first_pet"))
    assert "my_first_pet" not in out[1]


def test_value_length_is_recorded():
    """The redacted placeholder records the value length for debugging —
    so the dashboard can show 'user entered 26 chars into #password'
    without revealing what those chars were."""
    out = fov._redact_browser_args("fill", ("#password", "a" * 42))
    assert out[1] == "[REDACTED(len=42)]"


# ---------------------------------------------------------------------------
# goto URL redaction — strip query strings and fragments
# ---------------------------------------------------------------------------

def test_goto_url_strips_query_string():
    """Reviewer P1 fix: page.goto('https://example.com/reset?token=...')
    was leaking the token in the 'started' event args. Now goto's URL arg
    is passed through _redact_url()."""
    out = fov._redact_browser_args("goto", ("https://example.com/reset?token=CorrectHorseBatteryStaple!",))
    assert out[0] == "https://example.com/reset"
    assert "token=" not in out[0]
    assert "CorrectHorseBatteryStaple" not in out[0]


def test_goto_url_strips_fragment():
    out = fov._redact_browser_args("goto", ("https://example.com/app#access_token=eyJxyz",))
    assert out[0] == "https://example.com/app"


def test_goto_clean_url_preserved():
    out = fov._redact_browser_args("goto", ("https://example.com/path",))
    assert out[0] == "https://example.com/path"


# ---------------------------------------------------------------------------
# Pattern-based defense-in-depth — catches API keys / JWTs / emails / cards
# in ANY arg position
# ---------------------------------------------------------------------------

def test_api_key_in_selector_is_pattern_redacted():
    """An API key embedded in any arg position is redacted by the pattern
    layer, even when the method is not a value method."""
    out = fov._redact_browser_args(
        "click",
        ('[aria-label="ghp_' + "a" * 36 + '"]',),
    )
    assert "[REDACTED]" in out[0]


def test_jwt_in_non_value_method_arg_is_pattern_redacted():
    """A JWT in a click arg is pattern-redacted."""
    jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
    out = fov._redact_browser_args("click", (f"[data-token='{jwt}']",))
    assert "[REDACTED]" in out[0]
    assert jwt not in out[0]


# ---------------------------------------------------------------------------
# URL redaction helper — query strings and fragments carry tokens
# ---------------------------------------------------------------------------

def test_redact_url_strips_query_string():
    assert fov._redact_url("https://example.com/login?session=abc123") == "https://example.com/login"


def test_redact_url_strips_oauth_code():
    assert fov._redact_url("https://example.com/callback?code=oauth_xyz") == "https://example.com/callback"


def test_redact_url_strips_fragment():
    """SPAs put access tokens in URL fragments (#access_token=...)."""
    assert fov._redact_url("https://example.com/app#access_token=eyJxyz") == "https://example.com/app"


def test_redact_url_strips_fragment_with_jwt():
    jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature"
    assert fov._redact_url(f"https://example.com/app#access_token={jwt}") == "https://example.com/app"


def test_redact_url_preserves_clean_url():
    assert fov._redact_url("https://example.com/path") == "https://example.com/path"


def test_redact_url_handles_empty():
    assert fov._redact_url("") == ""
    assert fov._redact_url(None) == ""


def test_redact_url_strips_at_first_query_or_fragment():
    """If both ? and # appear, cut at whichever comes first."""
    assert fov._redact_url("https://example.com/a?x=1#y=2") == "https://example.com/a"
    assert fov._redact_url("https://example.com/a#y=2?x=1") == "https://example.com/a"


# ---------------------------------------------------------------------------
# End-to-end: the wrapped method actually emits redacted events
# ---------------------------------------------------------------------------

def test_wrapped_fill_emits_redacted_event(monkeypatch):
    """Drive _wrap_sync_method with a fake Page and confirm the captured
    event has [REDACTED(len=N)] for the password value — not the raw password.

    This is the test that would have FAILED on the original bug. It exercises
    the full code path: _wrap_sync_method -> _redact_browser_args -> _mk_event
    -> _save_event (captured via monkeypatch).
    """
    captured_events: list[dict] = []
    monkeypatch.setattr(fov, "_save_event", lambda ev: captured_events.append(ev))
    monkeypatch.setattr(fov, "_register_page", lambda *a, **k: None)
    monkeypatch.setattr(fov, "_current_agent", lambda: ("agent-1", "rag_bot"))

    class FakePage:
        url = "https://example.com/login"
        def fill(self, selector, value):
            assert value == "CorrectHorseBatteryStaple!", \
                "redaction must not change what the real method receives"
            return "ok"

    orig_fill = FakePage.fill
    wrapped = fov._wrap_sync_method("fill", orig_fill)
    page = FakePage()
    result = wrapped(page, "#password", "CorrectHorseBatteryStaple!")
    assert result == "ok"

    assert len(captured_events) == 2  # started + done

    started = captured_events[0]
    done = captured_events[1]

    # The password must NOT appear in either event's data.
    assert "CorrectHorseBatteryStaple" not in str(started), \
        f"password leaked into started event: {started}"
    assert "CorrectHorseBatteryStaple" not in str(done), \
        f"password leaked into done event: {done}"

    # The value arg must be [REDACTED(len=26)].
    assert started["data"]["args"] == ["#password", "[REDACTED(len=26)]"], started["data"]
    assert done["data"]["args"] == ["#password", "[REDACTED(len=26)]"], done["data"]

    # URL on the done event must have its query string stripped.
    assert done["data"]["url"] == "https://example.com/login"


def test_wrapped_goto_emits_redacted_url(monkeypatch):
    """Reviewer P1 fix: page.goto('https://example.com/reset?token=...')
    must not leak the token in the 'started' event args."""
    captured_events: list[dict] = []
    monkeypatch.setattr(fov, "_save_event", lambda ev: captured_events.append(ev))
    monkeypatch.setattr(fov, "_register_page", lambda *a, **k: None)
    monkeypatch.setattr(fov, "_current_agent", lambda: ("agent-1", "rag_bot"))

    class FakePage:
        url = "https://example.com/reset?token=secret123"
        def goto(self, url, **kwargs):
            return "ok"

    orig_goto = FakePage.goto
    wrapped = fov._wrap_sync_method("goto", orig_goto)
    page = FakePage()
    wrapped(page, "https://example.com/reset?token=secret123")

    started = captured_events[0]
    # The token must NOT appear in the event.
    assert "secret123" not in str(started), f"token leaked into goto event: {started}"
    # The URL must be stripped to origin + path.
    assert started["data"]["args"] == ["https://example.com/reset"], started["data"]


def test_wrapped_fill_redacts_value_repeated_in_error(monkeypatch):
    """A browser exception must not re-introduce an already-redacted value."""
    captured_events: list[dict] = []
    monkeypatch.setattr(fov, "_save_event", captured_events.append)
    monkeypatch.setattr(fov, "_register_page", lambda *a, **k: None)
    monkeypatch.setattr(fov, "_current_agent", lambda: ("agent-1", "browser_bot"))

    class FakePage:
        url = "https://example.com/login"

        def fill(self, selector, value):
            raise RuntimeError(f"could not submit value {value}")

    wrapped = fov._wrap_sync_method("fill", FakePage.fill)
    secret = "CorrectHorseBatteryStaple!"
    try:
        wrapped(FakePage(), "#password", secret)
    except RuntimeError:
        pass

    error = captured_events[-1]
    assert error["status"] == "error"
    assert secret not in str(error)
    assert "[REDACTED(len=26)]" in error["data"]["error"]


def test_stream_events_cannot_reassemble_split_api_key(monkeypatch):
    """Token-by-token redaction is insufficient when a key spans chunks."""
    captured_events: list[dict] = []
    monkeypatch.setattr(fov, "_save_event", captured_events.append)

    class Delta:
        def __init__(self, content):
            self.content = content

    class Choice:
        def __init__(self, content):
            self.delta = Delta(content)

    class Chunk:
        def __init__(self, content):
            self.choices = [Choice(content)]

    parts = ["sk-", "A" * 10, "A" * 20]
    list(fov._StreamWrapper(iter(Chunk(part) for part in parts), "agent-1", "bot"))

    assert len(captured_events) == 3
    assert all(event["data"]["token"] == "[REDACTED]" for event in captured_events)
    assert all(event["data"]["accumulated"] == "[REDACTED]" for event in captured_events)
    assert [event["data"]["token_chars"] for event in captured_events] == [3, 10, 20]
    assert "sk-" not in str(captured_events)
    assert "A" * 20 not in str(captured_events)
