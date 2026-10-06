"""Reusable input validators for the API edge."""

from typing import Annotated

from pydantic import AfterValidator


def reject_nul(value: str) -> str:
    """PostgreSQL cannot store (or compare against) a NUL character in text and answers
    with an error that would surface as a 500. It is never legitimate in a name or a
    search, so it is refused at the edge as an ordinary 422. Found by the property
    tests running against PostgreSQL; SQLite accepts it, which is why both are run."""
    if "\0" in value:
        msg = "must not contain NUL characters"
        raise ValueError(msg)
    return value


NoNul = AfterValidator(reject_nul)
Text = Annotated[str, NoNul]
