"""Executable architecture checks.

These tests keep the dependency boundaries documented in docs/ARCHITECTURE.md
from drifting as the codebase grows. They are intentionally lightweight AST
checks, not a full import-linter dependency.
"""

from __future__ import annotations

import ast
from fnmatch import fnmatchcase
from pathlib import Path

import pytest

try:  # Python 3.11+
    import tomllib
except ModuleNotFoundError:  # Python 3.10 — tomllib landed in 3.11
    try:
        import tomli as tomllib
    except ModuleNotFoundError:  # pragma: no cover - pytest supplies tomli here
        # In practice unreachable: pytest itself declares
        # `tomli>=1; python_version < "3.11"`, so anywhere pytest runs on 3.10
        # tomli is already installed and these checks really do run. This
        # branch only guards a hand-built environment — and it skips rather
        # than erroring, because a bare `import tomllib` here took the WHOLE
        # suite down at collection time on 3.10 (the version pyproject.toml
        # claims to support), which is how 3.10 went untested for so long.
        pytest.skip(
            "needs tomllib (Python 3.11+) or tomli",
            allow_module_level=True,
        )

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = ROOT / "swarmtrace"


def _distribution_packages() -> set[str]:
    """Discover packages using the include patterns configured in pyproject.

    Architecture checks should run with only the standard library and pytest.
    Importing ``setuptools`` here made test collection depend on a build-time
    package that is not necessarily installed in source checkouts.
    """
    config = tomllib.loads((ROOT / "pyproject.toml").read_text())
    patterns = config["tool"]["setuptools"]["packages"]["find"]["include"]
    packages = {
        ".".join(path.relative_to(ROOT).parent.parts)
        for path in ROOT.rglob("__init__.py")
    }
    return {package for package in packages if any(fnmatchcase(package, p) for p in patterns)}


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


def test_nested_runtime_packages_are_discovered_for_distribution():
    """The wheel must include adapter/delivery subpackages required at runtime."""
    packages = _distribution_packages()

    assert "swarmtrace" in packages
    assert "swarmtrace.adapters" in packages
    assert "swarmtrace.delivery" in packages


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
