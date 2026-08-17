"""Map OpenTelemetry trace payloads into SwarmTrace canonical SpanRecords.

This module is intentionally free of transport concerns: it only knows how to
convert the OTLP/JSON trace data model into the neutral ``SpanRecord`` used by
the rest of the SDK. The companion ``swarmtrace/otlp.py`` module handles HTTP
receipt and forwarding.

Supported OTLP fields:

* trace_id / span_id / parent_span_id (hex strings)
* name, kind, start/end timestamps (nanoseconds since epoch)
* status code and message
* attributes (string/int/double/bool/array/kvlist)
* resource attributes (merged into span attributes under ``resource.*``)
"""

from __future__ import annotations

import hashlib
from datetime import datetime, timezone
from typing import Any

from swarmtrace.redact import redact
from swarmtrace.span_model import SpanRecord

OTLP_KIND_MAP = {
    0: "function",  # SPAN_KIND_UNSPECIFIED
    1: "function",  # SPAN_KIND_INTERNAL
    2: "agent",     # SPAN_KIND_SERVER — treat as an agent root
    3: "tool",      # SPAN_KIND_CLIENT
    4: "function",  # SPAN_KIND_PRODUCER
    5: "function",  # SPAN_KIND_CONSUMER
}


def _hex_to_str(hex_val: str) -> str:
    """Normalize an OTLP hex id to a lowercase string."""
    if not isinstance(hex_val, str):
        return str(hex_val)
    return hex_val.lower()


def _nano_to_dt(nano: Any) -> datetime | None:
    """Convert nanoseconds-since-epoch to a UTC datetime."""
    if nano is None:
        return None
    try:
        sec = int(nano) / 1e9
        return datetime.fromtimestamp(sec, tz=timezone.utc)
    except Exception:
        return None


def _any_value_to_python(value: Any) -> Any:
    """Convert an OTLP AnyValue into a plain Python value."""
    if not isinstance(value, dict):
        return value
    if "stringValue" in value:
        return value["stringValue"]
    if "intValue" in value:
        try:
            return int(value["intValue"])
        except Exception:
            return value["intValue"]
    if "doubleValue" in value:
        return float(value["doubleValue"])
    if "boolValue" in value:
        return bool(value["boolValue"])
    if "arrayValue" in value:
        arr = value["arrayValue"]
        if isinstance(arr, dict):
            return [_any_value_to_python(v) for v in arr.get("values", [])]
        return []
    if "kvlistValue" in value:
        kv = value["kvlistValue"]
        if isinstance(kv, dict):
            return {
                item["key"]: _any_value_to_python(item.get("value"))
                for item in kv.get("values", [])
            }
        return {}
    return None


def _otlp_attributes_to_dict(attrs: Any) -> dict[str, Any]:
    """Convert a list of OTLP key/value attributes into a Python dict."""
    if not isinstance(attrs, list):
        return {}
    result: dict[str, Any] = {}
    for item in attrs:
        if not isinstance(item, dict):
            continue
        key = item.get("key")
        if key is None:
            continue
        result[key] = _any_value_to_python(item.get("value"))
    return result


def _derive_agent_id_and_name(
    resource_attrs: dict[str, Any],
    span_attrs: dict[str, Any],
    span_name: str,
) -> tuple[str | None, str | None]:
    """Derive agent_id / agent_name from OTLP resource and span attributes."""
    # Explicit SwarmTrace annotations take precedence.
    agent_id = span_attrs.get("swarmtrace.agent_id") or resource_attrs.get("swarmtrace.agent_id")
    agent_name = (
        span_attrs.get("swarmtrace.agent_name")
        or resource_attrs.get("swarmtrace.agent_name")
        or resource_attrs.get("service.name")
        or span_attrs.get("service.name")
    )
    if agent_id:
        return str(agent_id), agent_name or span_name

    # Otherwise fall back to the OpenTelemetry service name, hashed to match the
    # stable agent_id contract in docs/SDK_DASHBOARD_CONTRACT.md.
    service_name = resource_attrs.get("service.name")
    if service_name:
        agent_id = hashlib.sha256(str(service_name).encode("utf-8")).hexdigest()
        agent_name = agent_name or str(service_name)
    return agent_id, agent_name


def _pick(
    span_attrs: dict[str, Any],
    resource_attrs: dict[str, Any],
    *keys: str,
    default: Any = None,
) -> Any:
    """Return the first non-None value across span and resource attributes."""
    for d in (span_attrs, resource_attrs):
        for key in keys:
            if key in d and d[key] is not None:
                return d[key]
    return default


def otlp_span_to_span_record(
    otlp_span: dict[str, Any],
    resource_attrs: dict[str, Any] | None = None,
) -> SpanRecord:
    """Convert one OTLP span dict into a SwarmTrace SpanRecord.

    ``otlp_span`` is the JSON object inside ``scopeSpans[*].spans``.
    ``resource_attrs`` is the merged map from ``resourceSpans[*].resource.attributes``.
    """
    resource_attrs = resource_attrs or {}
    span_attrs = _otlp_attributes_to_dict(otlp_span.get("attributes"))
    all_attrs = {"resource." + k: v for k, v in resource_attrs.items()}
    all_attrs.update(span_attrs)

    trace_id = _hex_to_str(otlp_span.get("traceId", ""))
    span_id = _hex_to_str(otlp_span.get("spanId", ""))
    parent_id = otlp_span.get("parentSpanId")
    parent_span_id = _hex_to_str(parent_id) if parent_id else None

    name = otlp_span.get("name", span_id) or span_id
    kind_code = otlp_span.get("kind", 0)
    kind = OTLP_KIND_MAP.get(kind_code, "function")
    # Allow explicit override from span attributes.
    kind = span_attrs.get("swarmtrace.kind", resource_attrs.get("swarmtrace.kind", kind))

    start_time = _nano_to_dt(otlp_span.get("startTimeUnixNano")) or datetime.now(timezone.utc)
    end_time = _nano_to_dt(otlp_span.get("endTimeUnixNano"))
    latency = 0.0
    if end_time is not None:
        latency = round((end_time - start_time).total_seconds(), 3)

    status = otlp_span.get("status", {})
    status_code = status.get("code", 0) if isinstance(status, dict) else 0
    is_error = status_code == 2  # STATUS_CODE_ERROR
    error_message = status.get("message") if isinstance(status, dict) else None

    agent_id, agent_name = _derive_agent_id_and_name(resource_attrs, span_attrs, name)
    session_id = _pick(span_attrs, resource_attrs, "swarmtrace.session_id", "session_id")

    input_tokens = int(
        _pick(span_attrs, resource_attrs, "gen_ai.usage.input_tokens",
              "input_tokens", default=0) or 0
    )
    output_tokens = int(
        _pick(span_attrs, resource_attrs, "gen_ai.usage.output_tokens",
              "output_tokens", default=0) or 0
    )
    cost_usd = float(
        _pick(span_attrs, resource_attrs, "swarmtrace.cost_usd", "cost_usd", default=0.0) or 0.0
    )

    args_raw = _pick(span_attrs, resource_attrs, "swarmtrace.args", default="")
    output_raw = _pick(span_attrs, resource_attrs, "swarmtrace.output", default="")
    args = redact(str(args_raw))[:32000] if args_raw else None
    output = redact(str(output_raw))[:32000] if output_raw else None
    error = redact(str(error_message))[:32000] if error_message else None

    return SpanRecord(
        span_id=span_id,
        parent_span_id=parent_span_id,
        trace_id=trace_id or span_id,
        name=name,
        kind=kind,
        start_time=start_time,
        end_time=end_time,
        status="error" if is_error else "ok",
        latency_sec=latency,
        args=args,
        output=output,
        error=error,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        cost_usd=cost_usd,
        agent_id=agent_id,
        agent_name=agent_name,
        session_id=session_id,
        attributes=all_attrs,
    )


def otlp_payload_to_span_records(payload: dict[str, Any]) -> list[SpanRecord]:
    """Convert a full OTLP JSON trace payload into a list of SpanRecords."""
    records: list[SpanRecord] = []
    resource_spans = payload.get("resourceSpans") or []
    for resource_span in resource_spans:
        if not isinstance(resource_span, dict):
            continue
        resource_attrs = _otlp_attributes_to_dict(
            resource_span.get("resource", {}).get("attributes")
        )
        scope_spans = resource_span.get("scopeSpans") or []
        for scope_span in scope_spans:
            if not isinstance(scope_span, dict):
                continue
            spans = scope_span.get("spans") or []
            for span in spans:
                if not isinstance(span, dict):
                    continue
                records.append(otlp_span_to_span_record(span, resource_attrs))
    return records


def validate_otlp_payload(payload: Any) -> str | None:
    """Return an error string if the payload is invalid, or None if OK."""
    if not isinstance(payload, dict):
        return "OTLP payload must be a JSON object"
    if "resourceSpans" not in payload:
        return "OTLP payload missing 'resourceSpans'"
    if not isinstance(payload["resourceSpans"], list):
        return "'resourceSpans' must be a list"
    return None


__all__ = [
    "OTLP_KIND_MAP",
    "otlp_payload_to_span_records",
    "otlp_span_to_span_record",
    "validate_otlp_payload",
]
