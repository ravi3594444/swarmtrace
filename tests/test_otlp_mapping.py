"""Tests for OTLP to SwarmTrace span mapping."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from swarmtrace.otlp_mapping import (
    OTLP_KIND_MAP,
    otlp_payload_to_span_records,
    otlp_span_to_span_record,
    validate_otlp_payload,
)


def _make_otlp_span(**overrides):
    return {
        "traceId": "abc123",
        "spanId": "def456",
        "parentSpanId": "parent789",
        "name": "test-span",
        "kind": 1,
        "startTimeUnixNano": "1700000000000000000",
        "endTimeUnixNano": "1700000001000000000",
        "attributes": [],
        "status": {"code": 1},
        **overrides,
    }


def test_otlp_span_to_span_record_basic():
    span = otlp_span_to_span_record(_make_otlp_span())
    assert span.trace_id == "abc123"
    assert span.span_id == "def456"
    assert span.parent_span_id == "parent789"
    assert span.name == "test-span"
    assert span.kind == "function"
    assert span.status == "ok"
    assert span.latency_sec == 1.0
    assert isinstance(span.start_time, datetime)


def test_otlp_kind_mapping():
    for code, expected in OTLP_KIND_MAP.items():
        span = otlp_span_to_span_record(_make_otlp_span(kind=code))
        assert span.kind == expected


def test_otlp_error_status():
    span = otlp_span_to_span_record(
        _make_otlp_span(status={"code": 2, "message": "something failed"})
    )
    assert span.status == "error"
    assert "something failed" in span.error


def test_otlp_explicit_swarmtrace_kind():
    span = otlp_span_to_span_record(
        _make_otlp_span(
            kind=1,
            attributes=[
                {"key": "swarmtrace.kind", "value": {"stringValue": "tool"}}
            ],
        )
    )
    assert span.kind == "tool"


def test_otlp_attributes_converted():
    span = otlp_span_to_span_record(
        _make_otlp_span(
            attributes=[
                {"key": "service.name", "value": {"stringValue": "research-agent"}},
                {"key": "swarmtrace.agent_id", "value": {"stringValue": "agent-42"}},
                {"key": "swarmtrace.session_id", "value": {"stringValue": "session-42"}},
                {"key": "gen_ai.usage.input_tokens", "value": {"intValue": "100"}},
                {"key": "gen_ai.usage.output_tokens", "value": {"intValue": "50"}},
                {"key": "swarmtrace.cost_usd", "value": {"doubleValue": 0.001}},
                {"key": "swarmtrace.args", "value": {"stringValue": "hello"}},
                {"key": "swarmtrace.output", "value": {"stringValue": "world"}},
            ],
        )
    )
    assert span.agent_id == "agent-42"
    assert span.agent_name == "research-agent"
    assert span.session_id == "session-42"
    assert span.input_tokens == 100
    assert span.output_tokens == 50
    assert span.cost_usd == 0.001
    assert span.args == "hello"
    assert span.output == "world"


def test_otlp_agent_id_from_service_name():
    span = otlp_span_to_span_record(
        _make_otlp_span(),
        resource_attrs={"service.name": "my-agent"},
    )
    assert span.agent_id is not None
    assert span.agent_name == "my-agent"


def test_otlp_payload_to_span_records():
    payload = {
        "resourceSpans": [
            {
                "resource": {
                    "attributes": [
                        {"key": "service.name", "value": {"stringValue": "svc"}}
                    ]
                },
                "scopeSpans": [
                    {
                        "spans": [
                            _make_otlp_span(name="span-1"),
                            _make_otlp_span(name="span-2", spanId="span2"),
                        ]
                    }
                ],
            }
        ]
    }
    spans = otlp_payload_to_span_records(payload)
    assert len(spans) == 2
    assert spans[0].name == "span-1"
    assert spans[1].name == "span-2"
    assert spans[0].attributes.get("resource.service.name") == "svc"


def test_validate_otlp_payload():
    assert validate_otlp_payload({"resourceSpans": []}) is None
    assert validate_otlp_payload("not-a-dict") is not None
    assert validate_otlp_payload({}) is not None
    assert validate_otlp_payload({"resourceSpans": "bad"}) is not None


def test_otlp_nested_attributes():
    span = otlp_span_to_span_record(
        _make_otlp_span(
            attributes=[
                {
                    "key": "nested",
                    "value": {
                        "kvlistValue": {
                            "values": [
                                {"key": "a", "value": {"stringValue": "A"}},
                                {"key": "b", "value": {"intValue": "1"}},
                            ]
                        }
                    },
                }
            ]
        )
    )
    assert span.attributes["nested"] == {"a": "A", "b": 1}


def test_otlp_redacts_secrets():
    span = otlp_span_to_span_record(
        _make_otlp_span(
            attributes=[
                {
                    "key": "swarmtrace.args",
                    "value": {"stringValue": "token=sk-12345678901234567890abcdef"},
                }
            ]
        )
    )
    assert "sk-12345678901234567890abcdef" not in (span.args or "")


def test_otlp_missing_parent():
    span = otlp_span_to_span_record(_make_otlp_span().copy())
    # default _make_otlp_span has parentSpanId
    assert span.parent_span_id is not None

    raw = _make_otlp_span()
    raw.pop("parentSpanId")
    span2 = otlp_span_to_span_record(raw)
    assert span2.parent_span_id is None
