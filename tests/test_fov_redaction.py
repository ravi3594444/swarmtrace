"""Credential redaction for FOV events: value args, URLs, patterns and streams."""

from __future__ import annotations

import contextlib

from swarmtrace import fov

# value methods (fill/type/press/select_option) are always redacted

def test_fill_password_value_is_redacted():
    """page.fill('#password', ...) must not persist the password."""
    out = fov._redact_browser_args("fill", ("#password", "CorrectHorseBatteryStaple!"))
    assert out[0] == "#password"
    assert "CorrectHorseBatteryStaple" not in out[1]
    assert out[1] == "[REDACTED(len=26)]"


def test_type_password_value_is_redacted():
    """type() is also a value method, same redaction."""
    out = fov._redact_browser_args("type", ("#password", "hunter2"))
    assert out[1] == "[REDACTED(len=7)]"


def test_fill_generic_selector_still_redacts_value():
    """Generic selectors like input:nth-of-type(2) are redacted too, not just keyword ones."""
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
    """'.login-input', common in generated apps, doesn't match keywords."""
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
    """Every fill/type value is redacted, even for '#username'; only the length is kept."""
    out = fov._redact_browser_args("fill", ("#username", "ravi"))
    assert out[0] == "#username"
    assert "ravi" not in out[1]
    assert out[1] == "[REDACTED(len=4)]"

    out = fov._redact_browser_args("fill", ("#search", "hello world"))
    assert "hello world" not in out[1]
    assert out[1] == "[REDACTED(len=11)]"


def test_click_is_not_value_redacted():
    """click() isn't a value method, so its args pass through."""
    out = fov._redact_browser_args("click", ("#submit",))
    assert out == ["#submit"]


def test_select_option_value_redacted():
    out = fov._redact_browser_args("select_option", ("#security_question", "my_first_pet"))
    assert "my_first_pet" not in out[1]


def test_value_length_is_recorded():
    """The placeholder keeps the value length so the dashboard can show "26 chars into #password"."""
    out = fov._redact_browser_args("fill", ("#password", "a" * 42))
    assert out[1] == "[REDACTED(len=42)]"


# goto() URLs lose query strings and fragments

def test_goto_url_strips_query_string():
    """goto() must not leak tokens from the query string."""
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


# pattern-based redaction of keys/JWTs/emails/cards in any arg position

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


# _redact_url helper

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


# wrapped methods emit redacted events

def test_wrapped_fill_emits_redacted_event(monkeypatch):
    """Drive _wrap_sync_method with a fake Page; the events hold [REDACTED(len=N)], not the password."""
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
    """The 'started' event for goto() must not contain the token."""
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
    with contextlib.suppress(RuntimeError):
        wrapped(FakePage(), "#password", secret)

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
