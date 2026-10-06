"""Dependency audit: pip-audit over the exact locked set, with a reviewed allow-list.

`uv export` writes what `uv.lock` pins, hash-verified, including dev tools, and
pip-audit checks every package against the PyPI advisory database. Any known
vulnerability fails the run: pip-audit carries no severity, and "fail on high" is
not something it can say, so the policy is "fail on all, and let a person accept
a specific one on the record".

Accepting one means a line in `.pip-audit-ignore`:

    GHSA-xxxx-xxxx-xxxx  2026-12-31  why this does not apply here (reviewed by <name>)

An entry carries an expiry date; an expired entry fails the audit, so an exception
cannot be forgotten. Needs network access to the advisory database.
"""

import datetime as dt
import os
import shutil
import subprocess  # nosec B404 - runs uv and pip-audit with fixed arguments, no shell
import sys
import tempfile
from pathlib import Path

IGNORE_FILE = Path(".pip-audit-ignore")


def read_allow_list(today: dt.date) -> list[str]:
    ids: list[str] = []
    expired: list[str] = []
    if IGNORE_FILE.exists():
        for raw in IGNORE_FILE.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split(maxsplit=2)
            if len(parts) < 3:
                sys.exit(f"{IGNORE_FILE}: '{line}' needs an id, an expiry date and a reason")
            vuln_id, expires, _reason = parts
            if dt.date.fromisoformat(expires) < today:
                expired.append(f"{vuln_id} (expired {expires})")
            ids.append(vuln_id)
    if expired:
        sys.exit(f"{IGNORE_FILE}: review or remove expired entries: {', '.join(expired)}")
    return ids


def main() -> int:
    uv = os.environ.get("UV") or shutil.which("uv")
    if not uv:
        sys.exit("uv is required (https://docs.astral.sh/uv/)")
    allowed = read_allow_list(dt.datetime.now(dt.UTC).date())
    with tempfile.TemporaryDirectory() as tmp:
        requirements = Path(tmp) / "requirements.txt"
        subprocess.run(  # noqa: S603  # nosec B603
            [
                uv,
                "export",
                "--format",
                "requirements-txt",
                "--no-emit-project",
                "--locked",
                "--all-groups",
                "--no-header",
                "--output-file",
                str(requirements),
            ],
            check=True,
            capture_output=True,
        )
        command = [
            sys.executable,
            "-m",
            "pip_audit",
            "-r",
            str(requirements),
            "--no-deps",
            "--disable-pip",
            "--progress-spinner",
            "off",
        ]
        for vuln_id in allowed:
            command += ["--ignore-vuln", vuln_id]
        return subprocess.run(command, check=False).returncode  # noqa: S603  # nosec B603


if __name__ == "__main__":
    raise SystemExit(main())
