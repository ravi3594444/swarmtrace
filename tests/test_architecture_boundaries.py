"""Executable architecture checks.

These tests keep the dependency boundaries documented in docs/ARCHITECTURE.md
from drifting as the codebase grows. They are intentionally lightweight AST
checks, not a full import-linter dependency.
"""

from __future__ import annotations

import ast
import importlib.util
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = ROOT / "swarmtrace"

# setuptools is no longer installed into virtual environments by default from
# Python 3.12 onward (ensurepip stopped bundling it). A module-level
# `from setuptools import find_packages` therefore aborted collection of this
# entire file on 3.12/3.13 with ModuleNotFoundError — not a skip, a hard
# collection error that took every test in the module with it. It is declared
# in the `dev` extra so the check does run in CI, but the import is guarded so
# a minimal environment degrades to the filesystem check below instead of
# failing to collect.
_HAS_SETUPTOOLS = importlib.util.find_spec("setuptools") is not None

_REQUIRED_SUBPACKAGES = ["swarmtrace", "swarmtrace.adapters", "swarmtrace.delivery"]


def _imports(path: Path) -> set[str]:
    tree = ast.parse(path.read_text(), filename=str(path))
    found: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                found.add(alias.name)
        elif isinstance(node, ast.ImportFrom) and node.module:
            found.add(node.module)
    return found


def test_core_modules_do_not_import_infrastructure_or_public_facade():
    """Pure core modules should stay free of storage/transport/framework code."""
    core_modules = [
        PACKAGE / "config.py",
        PACKAGE / "span_model.py",
        PACKAGE / "trace_context.py",
        PACKAGE / "ports.py",
        PACKAGE / "events.py",
    ]
    forbidden_prefixes = (
        "swarmtrace.tracer",
        "swarmtrace.storage",
        "swarmtrace.adapters",
        "swarmtrace.delivery",
        "swarmtrace.auto_instrument",
        "swarmtrace.fov",
        "swarmtrace.mcp_gateway",
        "swarmtrace.otlp",
    )

    violations: list[str] = []
    for path in core_modules:
        for imported in _imports(path):
            if imported.startswith(forbidden_prefixes):
                violations.append(f"{path.relative_to(ROOT)} imports {imported}")

    assert violations == []


def test_runtime_and_optional_modules_use_shared_config_not_tracer_internals():
    """Modules below the public facade should not import tracer private config."""
    modules = [
        PACKAGE / "runtime.py",
        PACKAGE / "alerts.py",
        PACKAGE / "fov.py",
    ]

    violations = []
    for path in modules:
        for imported in _imports(path):
            if imported == "swarmtrace.tracer" or imported.startswith("swarmtrace.tracer."):
                violations.append(f"{path.relative_to(ROOT)} imports {imported}")

    assert violations == []


def test_nested_runtime_packages_exist_on_disk():
    """Every runtime subpackage must be a real package with an __init__.py.

    Setuptools-free counterpart to the discovery test below, so the invariant
    is still checked in an environment without setuptools (the default on
    Python 3.12+). ``packages.find`` in pyproject only picks up directories
    that are importable packages, so a missing __init__.py silently drops the
    subpackage from the wheel — an ImportError that appears only after
    install, never in the repo.
    """
    for dotted in _REQUIRED_SUBPACKAGES:
        pkg_dir = ROOT / Path(*dotted.split("."))
        assert pkg_dir.is_dir(), f"{dotted} is not a directory"
        assert (pkg_dir / "__init__.py").is_file(), f"{dotted} has no __init__.py"


@pytest.mark.skipif(not _HAS_SETUPTOOLS, reason="setuptools not installed")
def test_nested_runtime_packages_are_discovered_for_distribution():
    """The wheel must include adapter/delivery subpackages required at runtime.

    Runs the build backend's own discovery with the same ``include`` pattern
    pyproject uses, so it catches a packaging config that stops matching.
    """
    from setuptools import find_packages

    packages = set(find_packages(where=str(ROOT), include=["swarmtrace*"]))

    for dotted in _REQUIRED_SUBPACKAGES:
        assert dotted in packages, f"{dotted} would be missing from the wheel"


def test_architecture_document_covers_required_sections():
    doc = (ROOT / "docs" / "ARCHITECTURE.md").read_text()

    for heading in [
        "## 2. Architectural style",
        "## 3. Python SDK package map",
        "## 5. Canonical data model",
        "## 6. Main data flows",
        "## 8. Extension guidelines",
        "## 9. Resilience and privacy invariants",
    ]:
        assert heading in doc
