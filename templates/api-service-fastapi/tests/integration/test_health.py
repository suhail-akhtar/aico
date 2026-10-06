"""Probes: liveness never depends on the database; readiness does."""

import dataclasses

import httpx
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import create_async_engine

from app.core.container import Container
from tests.support import problem


async def test_healthz_is_ok(client: httpx.AsyncClient) -> None:
    response = await client.get("/healthz")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


async def test_readyz_is_ok_with_a_database(client: httpx.AsyncClient) -> None:
    response = await client.get("/readyz")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "database": "ok"}


async def test_readyz_is_503_when_the_database_is_down_but_healthz_stays_ok(
    client: httpx.AsyncClient, app: FastAPI
) -> None:
    container: Container = app.state.container
    broken = create_async_engine("sqlite+aiosqlite:///./no-such-directory/db.sqlite")
    app.state.container = dataclasses.replace(container, engine=broken)
    ready = await client.get("/readyz")
    assert ready.status_code == 503
    assert problem(ready)["code"] == "unavailable"
    assert (await client.get("/healthz")).status_code == 200
    await broken.dispose()


async def test_the_probes_need_no_authentication_and_are_not_versioned(
    client: httpx.AsyncClient,
) -> None:
    assert (await client.get("/v1/healthz")).status_code == 404
    assert (await client.get("/healthz")).status_code == 200
