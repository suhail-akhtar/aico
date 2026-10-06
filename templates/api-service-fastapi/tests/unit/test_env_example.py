"""`.env.example` documents every setting the service reads, and no real secrets.

A setting nobody can discover is a setting nobody sets: the commonest cause of
"it works on my machine" is an undocumented variable. This fails when a field is
added to `Settings` without a line in `.env.example`.
"""

from pathlib import Path

from app.core.config import Settings

EXAMPLE = Path(__file__).resolve().parents[2] / ".env.example"


def test_every_setting_is_documented() -> None:
    text = EXAMPLE.read_text(encoding="utf-8")
    missing = [name.upper() for name in Settings.model_fields if name.upper() not in text]
    assert missing == []


def test_secrets_in_the_example_are_obvious_placeholders() -> None:
    values = {
        key: value
        for line in EXAMPLE.read_text(encoding="utf-8").splitlines()
        if line and not line.startswith("#") and "=" in line
        for key, value in [line.split("=", 1)]
    }
    for key in ("JWT_SECRET", "SEED_PASSWORD", "POSTGRES_PASSWORD"):
        assert values[key].startswith("change-me"), key
