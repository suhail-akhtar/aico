# __APP_TITLE__

Laravel 13 / PHP 8.5 web app: Blade + Livewire 4, Fortify auth (Argon2id), Sanctum
token API, PostgreSQL in compose (SQLite when AICO runs it). Everything runs in
Docker: no PHP on the host. `php artisan app:dev` is the dev server.

## Layout

- `app/Features/<Feature>/{Models,Actions,Policies,Http,Enums}` — one folder per
  feature. **`Items` is the worked example: copy it.** `Accounts` is sign-up/auth.
- `app/Support/` — shared kernel: problem-details errors, security headers,
  request id, config guard. Never imports from `Features`.
- Logic lives in `Actions/*` (plain classes). `Http/Livewire/*` (web) and
  `Http/Controllers/*` (JSON API) stay thin: validate, authorise, call an action.
- `routes/web.php`, `routes/api.php` (`/api/v1`), `database/migrations` (append only).
- `docs/openapi.json` is generated: `composer openapi` after any API change.

## Conventions

- Every item query goes through `ListItems`/policies; another user's id is a 404.
- Validation rules live once (`ItemRules`), shared by Livewire and the API.
- Config from env only (`.env.example`); `app:check-config` refuses unsafe values.
- No `{!! !!}`, no `DB::raw` with input, no `env()` outside `config/`.
- API errors are RFC 9457 `application/problem+json`; keep that shape.

## Checks

`composer lint` (Pint), `composer analyse` (PHPStan level 10), `composer test`,
`composer cov` (>= 85%), `composer audit`. `make check` runs them in Docker.
Then `AppManage start` and `VerifyApp`: register, add an item, mark it done,
edit it, delete it, sign out, sign in.
