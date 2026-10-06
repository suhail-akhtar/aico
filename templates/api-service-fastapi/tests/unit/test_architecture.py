"""The layering rules, enforced instead of described.

A rule only a README states is broken within a month. These read the import
statements and fail the build when a dependency points the wrong way:

- `app.core` and `app.db` (the shared kernel) never import a feature;
- a feature never reaches into another feature's internals, only its package
  (`from app.features.users import User`, not `...users.models`);
- features never import the composition root (`app.main`).

The composition roots themselves (`main`, `cli`, `seed`, migrations) are exempt:
wiring everything together is their job.
"""

import ast
from pathlib import Path

SRC = Path(__file__).resolve().parents[2] / "src" / "app"


def _imports(path: Path) -> list[str]:
    modules: list[str] = []
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
        if isinstance(node, ast.ImportFrom) and node.module:
            modules.append(node.module)
        elif isinstance(node, ast.Import):
            modules.extend(alias.name for alias in node.names)
    return modules


def _files(*parts: str) -> list[Path]:
    return sorted((SRC.joinpath(*parts)).rglob("*.py"))


def test_the_shared_kernel_does_not_import_features() -> None:
    offenders = [
        f"{path.relative_to(SRC)} imports {module}"
        for folder in ("core", "db")
        for path in _files(folder)
        if "migrations" not in path.parts
        for module in _imports(path)
        if module.startswith("app.features")
    ]
    assert offenders == []


def test_features_only_use_each_others_public_package() -> None:
    offenders: list[str] = []
    for feature in (SRC / "features").iterdir():
        if not feature.is_dir() or feature.name.startswith("__"):
            continue
        for path in _files("features", feature.name):
            for module in _imports(path):
                parts = module.split(".")
                if parts[:2] != ["app", "features"] or len(parts) < 3:
                    continue
                other = parts[2]
                if other != feature.name and len(parts) > 3:
                    offenders.append(f"{path.relative_to(SRC)} imports {module}")
    assert offenders == []


def test_features_do_not_import_the_composition_root() -> None:
    offenders = [
        f"{path.relative_to(SRC)} imports {module}"
        for path in _files("features")
        for module in _imports(path)
        if module in {"app.main", "app.cli", "app.seed"}
    ]
    assert offenders == []


def test_there_are_no_dependency_cycles_between_features() -> None:
    graph: dict[str, set[str]] = {}
    for feature in (SRC / "features").iterdir():
        if feature.is_dir() and not feature.name.startswith("__"):
            graph[feature.name] = {
                module.split(".")[2]
                for path in _files("features", feature.name)
                for module in _imports(path)
                if module.startswith("app.features.") and module.split(".")[2] != feature.name
            }

    def reaches(start: str, goal: str, seen: frozenset[str] = frozenset()) -> bool:
        return any(
            step == goal or (step not in seen and reaches(step, goal, seen | {step}))
            for step in graph.get(start, ())
        )

    assert [name for name in graph if reaches(name, name)] == []
