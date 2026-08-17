"""The ports in ``swarmtrace.ports`` must describe what the runtime calls.

Why this file exists
--------------------
``ports.py`` is the documented extension point: "implement SpanTransport and
plug in your own delivery". Before this test the protocol had drifted badly
from reality and nothing caught it, because Protocols are structural — Python
never checks that an adapter matches, and no test compared the two:

* ``SpanTransport`` declared exactly one method, ``send(spans)``. Nothing in
  the codebase had that signature and nothing called it. The live path calls
  ``send_batch(payloads, key, url)``, the resync CLI calls
  ``send_single(payload, key, url)``, and the OTLP collector calls
  ``send(spans, key, url)``. A transport written against the documented
  contract raised ``AttributeError`` on the first flush — inside the sender
  thread, which catches broad ``Exception`` and only logs, so the failure was
  invisible and traces silently stopped shipping.

* ``SpanRepository.mark_synced(span_id, synced)`` declared ``synced`` as
  required, but the sender's success path calls ``mark_synced(payload["id"])``
  with one argument. A conforming repository raised ``TypeError`` on every
  successful batch — again swallowed by the worker — so rows were delivered
  but never marked, and resync replayed them forever.

Both are the same failure mode: a contract nobody executes. These tests
execute it. They check signature *compatibility*, not identity — an
implementation may add optional parameters or widen defaults, but it may not
require an argument the port says is optional, or omit a method the runtime
depends on.
"""

from __future__ import annotations

import inspect
from typing import Any, get_type_hints

import pytest

from swarmtrace.adapters.http_transport import HttpTransport
from swarmtrace.adapters.sqlite_repository import SqliteRepository
from swarmtrace.delivery.sender import Sender
from swarmtrace.ports import SpanRepository, SpanTransport
from swarmtrace.runtime import Runtime
from tests._fakes import FakeRepository, FakeTransport


def _protocol_methods(protocol: type) -> list[str]:
    """Public method names a Protocol declares."""
    return [
        name
        for name, member in vars(protocol).items()
        if not name.startswith("_") and inspect.isfunction(member)
    ]


def _assert_callable_with(impl: object, protocol: type, method: str) -> None:
    """The implementation must accept every call the protocol permits.

    Builds the protocol's minimal call (required params only) and its maximal
    call (all params) and binds both against the implementation's signature.
    ``inspect.Signature.bind`` raises ``TypeError`` on an arity or keyword
    mismatch, which is precisely the drift we care about.
    """
    assert hasattr(impl, method), (
        f"{type(impl).__name__} is missing {protocol.__name__}.{method}() — "
        f"the runtime calls this method, so the adapter cannot work without it"
    )

    proto_sig = inspect.signature(getattr(protocol, method))
    impl_sig = inspect.signature(getattr(impl, method))

    proto_params = [p for n, p in proto_sig.parameters.items() if n != "self"]

    required = [p.name for p in proto_params if p.default is inspect.Parameter.empty]
    optional = [p.name for p in proto_params if p.default is not inspect.Parameter.empty]

    # Minimal call: only the parameters the protocol says are required.
    try:
        impl_sig.bind(*[object() for _ in required])
    except TypeError as exc:
        pytest.fail(
            f"{type(impl).__name__}.{method}{impl_sig} cannot be called the way "
            f"{protocol.__name__}.{method}{proto_sig} permits — a caller passing "
            f"only the required args {required} gets: {exc}"
        )

    # Maximal call: every parameter the protocol declares.
    try:
        impl_sig.bind(*[object() for _ in required + optional])
    except TypeError as exc:
        pytest.fail(
            f"{type(impl).__name__}.{method}{impl_sig} rejects the full argument "
            f"list {required + optional} that {protocol.__name__}.{method} "
            f"declares: {exc}"
        )


@pytest.mark.parametrize(
    "impl",
    [HttpTransport(), FakeTransport()],
    ids=["HttpTransport", "FakeTransport"],
)
@pytest.mark.parametrize("method", _protocol_methods(SpanTransport))
def test_transport_implementations_satisfy_the_port(impl: Any, method: str) -> None:
    _assert_callable_with(impl, SpanTransport, method)


@pytest.mark.parametrize(
    "impl",
    [SqliteRepository(), FakeRepository()],
    ids=["SqliteRepository", "FakeRepository"],
)
@pytest.mark.parametrize("method", _protocol_methods(SpanRepository))
def test_repository_implementations_satisfy_the_port(impl: Any, method: str) -> None:
    _assert_callable_with(impl, SpanRepository, method)


def test_port_declares_every_transport_method_the_runtime_calls() -> None:
    """No caller may depend on a transport method the port doesn't declare.

    ``Runtime.resync`` used to call ``send_single`` while the port declared
    only ``send`` — so the port under-described the real dependency and a
    conforming transport crashed at resync time.
    """
    declared = set(_protocol_methods(SpanTransport))
    for method in ("send", "send_batch", "send_single"):
        assert method in declared, (
            f"the runtime calls transport.{method}(), so SpanTransport must "
            f"declare it — otherwise a conforming custom transport raises "
            f"AttributeError inside the sender thread, where it is swallowed"
        )


def test_mark_synced_synced_arg_is_optional_in_the_port() -> None:
    """The sender calls ``mark_synced(id)`` with one argument.

    If the port makes ``synced`` required, a conforming repository raises
    TypeError on the sender's success path — swallowed by the worker's broad
    except, leaving rows delivered but permanently unsynced.
    """
    sig = inspect.signature(SpanRepository.mark_synced)
    assert sig.parameters["synced"].default is not inspect.Parameter.empty


def test_sender_annotates_its_injected_collaborators() -> None:
    """``Sender.__init__`` must be annotated with the ports.

    Its ``transport`` and ``repository`` parameters were originally unannotated,
    which is why a type checker could not see either of the mismatches above.
    Keeping the annotations means the contract is enforced statically from now
    on rather than only by this file.
    """
    hints = get_type_hints(Sender.__init__)
    assert hints.get("transport") is SpanTransport
    assert hints.get("repository") is SpanRepository


def test_runtime_accepts_the_shipped_adapters() -> None:
    """End-to-end wiring check: the real adapters compose into a Runtime."""
    runtime = Runtime(SqliteRepository(), HttpTransport(), lambda: ("", ""))
    assert runtime.transport is not None
    assert runtime.repository is not None
