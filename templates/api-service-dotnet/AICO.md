# __APP_TITLE__

JSON API on .NET 10 / ASP.NET Core minimal APIs, EF Core, JWT auth. One project,
feature folders. SQLite in dev (no server), PostgreSQL in compose and prod.

## Layout (`src/ApiService/`)

- `Program.cs` composition root. `Features/<Name>/` one folder per feature: entity,
  service, endpoints, DTOs, `AddXFeature`. **`Features/Items` is the worked
  feature: copy it.** `Features/Auth` is local login, or with `AUTH_MODE=oidc` an OIDC resource server
  (`OIDC_ISSUER`, `OIDC_JWKS_URI`, `OIDC_AUDIENCE`; RS256, users created on first token).
- `Platform/` cross-cutting (errors, rate limit, CORS, headers, health, OpenAPI).
- `Persistence/` `AppDbContext`, `Migrations/`. `SharedKernel/` ids, paging, exceptions.
- `tests/ApiService.Tests/` in-memory host; `Snapshots/openapi.v1.json` is the contract.

## Rules (tests enforce them)

- Every query is scoped to the caller (`Owned(ownerId)`); other users' rows are 404.
- Request DTOs are `public` with DataAnnotations (internal ones skip validation).
- Throw `NotFound/Conflict/UnauthorizedException`; never write an error body.
- Schema change = `make migration name=X`; never edit a committed migration.
- API change = `UPDATE_SNAPSHOTS=1 dotnet test`, review the diff, commit.
- Features never reference each other; see `docs/ARCHITECTURE.md`.
- JSON is snake_case (one policy); lists use `limit`, `cursor`, `next_cursor`.
- Config is env only (`.env.example`); warnings are errors.

## Checks

`dotnet build ApiService.slnx -warnaserror`, `dotnet test --solution ApiService.slnx`,
`dotnet format ApiService.slnx --verify-no-changes`. Then `AppManage start` and
`VerifyApp`: `/healthz`, `/readyz`, `/openapi/v1.json`, log in as
`demo@example.test` (password in `.env.local`, `Seed__DemoPassword`), `GET /items`,
POST `{"name":""}` answers 400 naming `name`.
