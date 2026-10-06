"""Identifiers: UUIDv7 (time-ordered), generated in the application.

Not sequential integers: they leak row counts and make object-level
authorisation bugs trivially enumerable. Not random UUIDv4: those scatter inserts
across the primary-key index. v7 sorts by creation time, which also makes keyset
pagination on the id alone correct (see `pagination.py`).
"""

from uuid import UUID, uuid7


def new_id() -> UUID:
    return uuid7()
