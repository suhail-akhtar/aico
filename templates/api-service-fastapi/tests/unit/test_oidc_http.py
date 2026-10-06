"""The real JWKS fetcher against a loopback HTTP server (no outside network).

`FakeJwks` stands in for the provider everywhere else; this file is the one place the
actual `urllib` fetcher runs, so its limits are proven rather than assumed: it succeeds
on a good document, and it fails (rather than hanging, following a redirect or reading
without bound) on every bad one.
"""

import json
import threading
import time
from collections.abc import Callable, Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import pytest

from app.core.oidc import MAX_JWKS_BYTES, HttpJwksFetcher
from tests.oidc_support import FakeJwks

Reply = Callable[[BaseHTTPRequestHandler], None]


class Provider:
    """A tiny server whose reply the test chooses."""

    def __init__(self) -> None:
        self.reply: Reply = lambda _handler: None
        provider = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                provider.reply(self)

            def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
                """Keep the test output clean."""

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_port}/certs"

    def stop(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


def send(status: int, body: bytes, headers: dict[str, str] | None = None) -> Reply:
    def reply(handler: BaseHTTPRequestHandler) -> None:
        handler.send_response(status)
        handler.send_header("Content-Type", "application/json")
        handler.send_header("Content-Length", str(len(body)))
        for name, value in (headers or {}).items():
            handler.send_header(name, value)
        handler.end_headers()
        handler.wfile.write(body)

    return reply


@pytest.fixture
def provider() -> Iterator[Provider]:
    server = Provider()
    yield server
    server.stop()


async def test_a_good_document_is_returned(provider: Provider) -> None:
    document = await FakeJwks()()
    provider.reply = send(200, json.dumps(document).encode())
    assert await HttpJwksFetcher(provider.url, 5)() == document


@pytest.mark.parametrize(
    "reply",
    [
        pytest.param(send(404, b"{}"), id="not-found"),
        pytest.param(send(500, b"{}"), id="server-error"),
        pytest.param(send(204, b""), id="no-content"),
        pytest.param(send(200, b"not json"), id="invalid-json"),
        pytest.param(send(200, b"[1, 2]"), id="not-an-object"),
        pytest.param(send(200, b" " * (MAX_JWKS_BYTES + 10)), id="too-large"),
        pytest.param(send(302, b"", {"Location": "http://127.0.0.1:1/x"}), id="redirect"),
    ],
)
async def test_a_bad_answer_is_an_error_not_a_document(provider: Provider, reply: Reply) -> None:
    provider.reply = reply
    with pytest.raises((OSError, ValueError, TypeError)):
        await HttpJwksFetcher(provider.url, 5)()


async def test_a_server_that_never_answers_is_cut_off_at_the_deadline(provider: Provider) -> None:
    provider.reply = lambda _handler: time.sleep(3)
    started = time.monotonic()
    with pytest.raises((OSError, TimeoutError)):
        await HttpJwksFetcher(provider.url, 1)()
    assert time.monotonic() - started < 2.5


async def test_nothing_listening_is_an_error() -> None:
    with pytest.raises(OSError):  # noqa: PT011 - URLError and ConnectionError are both OSError
        await HttpJwksFetcher("http://127.0.0.1:1/certs", 1)()


@pytest.mark.parametrize(
    "uri", ["file:///etc/passwd", "ftp://example.test/certs", "keycloak/certs"]
)
def test_only_http_and_https_uris_are_accepted(uri: str) -> None:
    with pytest.raises(ValueError, match="http"):
        HttpJwksFetcher(uri, 1)
