"""Pure-ASGI middleware: request id and access log, security headers, body-size limit.

Written against the ASGI interface rather than `BaseHTTPMiddleware` because that
class runs the app in a separate task, which breaks context variables (the
request id would not reach the logs), buffers streaming bodies, and swallows
client disconnects. Pure ASGI has none of those problems and is barely longer.

The `Server: uvicorn` header is added by uvicorn's protocol layer after the app
has finished, so no middleware can remove it: the run commands pass
`--no-server-header` (Dockerfile, Makefile, template.json).

Order, outermost first: request context, security headers, CORS (added in
`main.py`), body limit, then the app.
"""

import re
import time
from uuid import uuid4

import structlog
from starlette.datastructures import Headers, MutableHeaders
from starlette.requests import Request
from starlette.responses import Response
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.core.errors import PayloadTooLargeError
from app.core.headers import HSTS, SECURITY_HEADERS
from app.core.problems import problem_response

log = structlog.get_logger("app.http")

_REQUEST_ID = re.compile(r"^[A-Za-z0-9._-]{8,128}$")


class RequestContextMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        inbound = Headers(scope=scope).get("x-request-id", "")
        request_id = inbound if _REQUEST_ID.match(inbound) else uuid4().hex
        scope.setdefault("state", {})["request_id"] = request_id
        structlog.contextvars.bind_contextvars(request_id=request_id)
        started = time.perf_counter()
        status = 500

        async def send_with_id(message: Message) -> None:
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
                headers = MutableHeaders(scope=message)
                headers["x-request-id"] = request_id
            await send(message)

        try:
            await self.app(scope, receive, send_with_id)
        finally:
            path = scope["path"]
            for name, value in scope.get("path_params", {}).items():
                # Log the route, not the URL: ids in the path would make every line unique.
                path = path.replace(str(value), "{" + name + "}", 1)
            # The query string is deliberately not logged: it can carry tokens.
            event = log.error if status >= 500 else log.info
            event(
                "http.request",
                method=scope["method"],
                path=path,
                status=status,
                duration_ms=round((time.perf_counter() - started) * 1000, 2),
            )
            structlog.contextvars.clear_contextvars()


class SecurityHeadersMiddleware:
    def __init__(self, app: ASGIApp, relaxed_paths: tuple[str, ...] = ()) -> None:
        self.app = app
        self.relaxed_paths = relaxed_paths

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        relaxed = scope["path"] in self.relaxed_paths
        https = scope.get("scheme") == "https"

        async def send_with_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                for name, value in SECURITY_HEADERS.items():
                    if name == "content-security-policy" and relaxed:
                        continue
                    if name == "cache-control" and "cache-control" in headers:
                        continue
                    headers[name] = value
                if https:
                    headers["strict-transport-security"] = HSTS
            await send(message)

        await self.app(scope, receive, send_with_headers)


class BodySizeLimitMiddleware:
    """413 for a body over the limit, whether declared (Content-Length) or streamed.

    A declared size is refused before the app runs. A streamed body (chunked, no
    Content-Length) is counted as it is read; when it crosses the limit reading
    stops and whatever the app answered is replaced with the 413. The replacement
    matters: FastAPI turns any error raised while it reads a body into its own 400,
    which would hide the real reason.
    """

    def __init__(self, app: ASGIApp, max_bytes: int) -> None:
        self.app = app
        self.max_bytes = max_bytes

    def _too_large(self, scope: Scope) -> Response:
        return problem_response(
            Request(scope),
            status=413,
            code="payload_too_large",
            title="Payload Too Large",
            detail=f"The request body may not exceed {self.max_bytes} bytes.",
        )

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        declared = Headers(scope=scope).get("content-length", "")
        if declared.isdigit() and int(declared) > self.max_bytes:
            await self._too_large(scope)(scope, receive, send)
            return
        received = 0
        exceeded = False
        replaced = False

        async def limited_receive() -> Message:
            nonlocal received, exceeded
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > self.max_bytes:
                    exceeded = True
                    raise PayloadTooLargeError
            return message

        async def guarded_send(message: Message) -> None:
            nonlocal replaced
            if not exceeded:
                await send(message)
            elif not replaced:
                replaced = True
                await self._too_large(scope)(scope, receive, send)

        await self.app(scope, limited_receive, guarded_send)
