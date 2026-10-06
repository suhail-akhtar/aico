"""Small pieces of the shared kernel: pagination cursors, the rate limiter, logging."""

import io
import json
import logging
from uuid import UUID, uuid4

import pytest
import structlog

from app.core.errors import BadRequestError
from app.core.logging import REDACTED, configure_logging, redact
from app.core.pagination import decode_cursor, encode_cursor, slice_page
from app.core.ratelimit import MemoryRateLimiter


def test_a_cursor_round_trips() -> None:
    value = uuid4()
    assert decode_cursor(encode_cursor(value)) == value


# The last one decodes to the nil id but is not the canonical spelling of it.
@pytest.mark.parametrize("bad", ["", "abc", "!!!!", "A" * 22 + "B", "A" * 40, "A" * 22 + "=="])
def test_a_malformed_cursor_is_a_bad_request(bad: str) -> None:
    with pytest.raises(BadRequestError):
        decode_cursor(bad)


def test_slice_page_reports_a_next_cursor_only_when_a_row_is_left_over() -> None:
    ids = [UUID(int=n) for n in range(5)]
    items, cursor = slice_page(ids, 3, lambda i: i)
    assert items == ids[:3]
    assert cursor == encode_cursor(ids[2])
    items, cursor = slice_page(ids[:3], 3, lambda i: i)
    assert items == ids[:3]
    assert cursor is None
    assert slice_page([], 3, lambda i: i) == ([], None)


async def test_the_rate_limiter_allows_the_quota_then_says_when_to_retry() -> None:
    limiter = MemoryRateLimiter()
    results = [await limiter.check("3/minute", "1.2.3.4") for _ in range(4)]
    assert [r.allowed for r in results] == [True, True, True, False]
    assert 1 <= results[-1].retry_after_seconds <= 60


async def test_the_rate_limiter_counts_each_key_separately() -> None:
    limiter = MemoryRateLimiter()
    for _ in range(2):
        await limiter.check("2/minute", "a")
    assert (await limiter.check("2/minute", "a")).allowed is False
    assert (await limiter.check("2/minute", "b")).allowed is True


def test_redaction_masks_sensitive_keys_at_any_depth() -> None:
    event = {
        "event": "login",
        "password": "hunter2",
        "Authorization": "Bearer abc",
        "refresh_token": "r",
        "nested": {"api_key": "k", "fine": "visible"},
        "user_id": "42",
    }
    out = redact(None, "info", event)
    assert out["password"] == out["Authorization"] == out["refresh_token"] == REDACTED
    assert out["nested"] == {"api_key": REDACTED, "fine": "visible"}
    assert out["user_id"] == "42"


def test_json_logs_are_one_object_per_line_and_redacted() -> None:
    stream = io.StringIO()
    configure_logging("INFO", "json", stream)
    structlog.get_logger("test").info("something.happened", password="hunter2", count=3)
    logging.getLogger("stdlib.logger").warning("from the standard library")
    lines = [json.loads(line) for line in stream.getvalue().splitlines()]
    assert lines[0]["event"] == "something.happened"
    assert lines[0]["password"] == REDACTED
    assert lines[0]["count"] == 3
    assert lines[0]["level"] == "info"
    assert "timestamp" in lines[0]
    assert lines[1]["event"] == "from the standard library"
    assert "hunter2" not in stream.getvalue()


def test_a_logged_exception_does_not_print_local_variables() -> None:
    stream = io.StringIO()
    configure_logging("INFO", "json", stream)

    def explode() -> None:
        secret_password = "hunter2-in-a-local-variable"  # noqa: F841 - the point of the test
        raise RuntimeError("boom")

    try:
        explode()
    except RuntimeError:
        structlog.get_logger("test").exception("failed")
    output = stream.getvalue()
    assert "boom" in output
    assert "hunter2-in-a-local-variable" not in output
