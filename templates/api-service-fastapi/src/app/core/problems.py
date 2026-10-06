"""RFC 9457 problem details: one error shape for every failure.

Every non-2xx response is `application/problem+json` with a stable `code`, the
request id (so a user's report can be found in the logs), and for validation
failures an `errors[]` list. The shapes are also published in the OpenAPI
document, so a generated client and the contract test both know them.

Two things this module is careful about:
- Validation errors never echo the offending input. FastAPI's default does, and
  an input that failed validation is often a password.
- An unhandled exception answers a generic 500. The traceback goes to the log,
  never to the client.
"""

import re
from collections.abc import Mapping
from typing import Any

import structlog
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.responses import JSONResponse

from app.core.errors import AppError
from app.core.headers import SECURITY_HEADERS

PROBLEM_MEDIA_TYPE = "application/problem+json"
log = structlog.get_logger(__name__)


class FieldError(BaseModel):
    loc: list[str | int]
    message: str
    type: str


class ProblemDetails(BaseModel):
    type: str
    title: str
    status: int
    detail: str | None = None
    instance: str | None = None
    code: str
    request_id: str | None = None


class ValidationProblem(ProblemDetails):
    errors: list[FieldError]


class ProblemResponse(JSONResponse):
    media_type = PROBLEM_MEDIA_TYPE


def problem_response(
    request: Request,
    *,
    status: int,
    code: str,
    title: str,
    detail: str | None = None,
    headers: Mapping[str, str] | None = None,
    extra: Mapping[str, Any] | None = None,
) -> ProblemResponse:
    body: dict[str, Any] = {
        "type": f"urn:problem:{code.replace('_', '-')}",
        "title": title,
        "status": status,
        "detail": detail,
        "instance": request.url.path,
        "code": code,
        "request_id": getattr(request.state, "request_id", None),
    }
    body.update(extra or {})
    return ProblemResponse(body, status_code=status, headers=dict(headers or {}))


async def _app_error(request: Request, exc: Exception) -> ProblemResponse:
    if not isinstance(exc, AppError):
        raise exc  # registered for AppError only; anything else is a wiring bug
    return problem_response(
        request,
        status=exc.status_code,
        code=exc.code,
        title=exc.title,
        detail=exc.detail,
        headers=exc.headers,
        extra=exc.extra,
    )


async def _validation_error(request: Request, exc: Exception) -> ProblemResponse:
    if not isinstance(exc, RequestValidationError):
        raise exc  # registered for RequestValidationError only; anything else is a wiring bug
    errors = [
        {"loc": list(err["loc"]), "message": str(err["msg"]), "type": str(err["type"])}
        for err in exc.errors()  # deliberately not err["input"] or err["ctx"]
    ]
    return problem_response(
        request,
        status=422,
        code="validation_error",
        title="Unprocessable Content",
        detail="The request did not pass validation.",
        extra={"errors": errors},
    )


_HTTP_CODES = {404: "not_found", 405: "method_not_allowed", 415: "unsupported_media_type"}


def _allowed_methods(request: Request) -> str:
    """The methods this path really supports, read from the OpenAPI document.

    Starlette's own 405 lists only the first route that matched the path, which is
    wrong when one path has several methods (RFC 9110 says `Allow` must be complete).
    """
    methods: set[str] = set()
    for template, operations in request.app.openapi().get("paths", {}).items():
        if re.fullmatch(re.sub(r"\{[^}]+\}", "[^/]+", template), request.url.path):
            methods |= {m.upper() for m in operations}
    return ", ".join(sorted(methods))


async def _http_error(request: Request, exc: Exception) -> ProblemResponse:
    if not isinstance(exc, StarletteHTTPException):
        raise exc  # registered for StarletteHTTPException only; anything else is a wiring bug
    code = _HTTP_CODES.get(exc.status_code, f"http_{exc.status_code}")
    headers = dict(exc.headers or {})
    if exc.status_code == 405:
        headers["Allow"] = _allowed_methods(request)
    title = {404: "Not Found", 405: "Method Not Allowed"}.get(exc.status_code, "Request Failed")
    return problem_response(
        request,
        status=exc.status_code,
        code=code,
        title=title,
        detail=str(exc.detail),
        headers=headers,
    )


async def _unhandled(request: Request, exc: Exception) -> ProblemResponse:
    log.error("http.unhandled_exception", exc_info=exc, path=request.url.path)
    # This runs in ServerErrorMiddleware, outside our middleware stack, so the
    # headers those would add are added here.
    headers = {"x-request-id": getattr(request.state, "request_id", "")}
    headers.update(SECURITY_HEADERS)
    return problem_response(
        request,
        status=500,
        code="internal_error",
        title="Internal Server Error",
        detail="Something went wrong. Quote the request id when reporting it.",
        headers=headers,
    )


def problem_responses(*statuses: int) -> dict[int | str, dict[str, Any]]:
    """The `responses=` entry that documents problem+json for these status codes."""
    docs: dict[int | str, dict[str, Any]] = {}
    for status in statuses:
        schema = "ValidationProblem" if status == 422 else "ProblemDetails"
        docs[status] = {
            "description": "Problem details (RFC 9457)",
            "content": {PROBLEM_MEDIA_TYPE: {"schema": {"$ref": f"#/components/schemas/{schema}"}}},
        }
    return docs


def install_problem_handling(app: FastAPI) -> None:
    """Register the handlers and publish the problem schemas in the OpenAPI document."""
    app.add_exception_handler(AppError, _app_error)
    app.add_exception_handler(RequestValidationError, _validation_error)
    app.add_exception_handler(StarletteHTTPException, _http_error)
    app.add_exception_handler(Exception, _unhandled)

    original = app.openapi

    def openapi_with_problems() -> dict[str, Any]:
        schema = original()
        schemas = schema.setdefault("components", {}).setdefault("schemas", {})
        for model in (ProblemDetails, ValidationProblem):
            js = model.model_json_schema(
                ref_template="#/components/schemas/{model}", mode="serialization"
            )
            for name, definition in js.pop("$defs", {}).items():
                schemas.setdefault(name, definition)
            schemas.setdefault(model.__name__, js)
        return schema

    app.openapi = openapi_with_problems  # type: ignore[method-assign]
