# Extending this app

## Add a feature (the main move)

Copy the `Items` slice. For a feature called `Projects`:

1. **Migration.** `php artisan make:migration create_projects_table`. Use `ulid('id')->primary()`,
   `foreignId('user_id')->constrained()->cascadeOnDelete()`, real lengths, and an index
   for the list order. Never edit a migration that has shipped; add a new one.
2. **Model.** Copy `app/Features/Items/Models/Item.php` to `app/Features/Projects/Models/Project.php`.
   `#[Fillable]` lists only editable columns (never `user_id`); add `#[UsePolicy]`, `#[UseFactory]`.
3. **Policy.** Copy `ItemPolicy`. Someone else's row answers `Response::denyAsNotFound()`.
4. **Actions.** Copy `CreateItem`, `UpdateItem`, `DeleteItem`, `ListItems` and `ItemInput`.
   Business rules go here, with no HTTP types. Wrap multi-step writes in `DB::transaction`.
5. **Rules + requests.** One `ProjectRules` class; `StoreProjectRequest` / `UpdateProjectRequest`
   return its rules; the Livewire form object returns them too.
6. **API.** Copy `ItemController` and `ItemResource` (the resource is the public contract;
   a new column stays private until listed). Add `Route::apiResource('projects', ...)` in `routes/api.php`
   inside the `auth:sanctum` group. Run `composer openapi` and commit `docs/openapi.json`.
7. **Page.** Copy `Http/Livewire/ItemsPage.php` and `resources/views/items/page.blade.php`,
   register `Route::livewire('/projects', ProjectsPage::class)->middleware('auth')` in `routes/web.php`
   (no closures in route files), add a nav link in `resources/views/layouts/app.blade.php`.
8. **Tests.** Copy `ItemsApiTest` and `ItemsPageTest`; keep the ownership (404), validation,
   hostile-string and pagination cases. Add the feature to `ArchitectureTest`. `make check`.

## Add a column

A new migration (`Schema::table`), then `#[Fillable]`, the rules,
the `ItemInput` DTO, the resource, the Livewire form and view, `composer openapi`, tests.
A `NOT NULL` column needs a `default` or a backfill.

## Add roles or teams

Add a `role` column (or `teams` + `memberships`), expose it on `User`, and express it in the
**policy** (`ItemPolicy::owns`). Authorisation lives in policies only: never in a view, never
only in a Livewire property. For many roles use `spatie/laravel-permission` (record the ADR first).

## Send mail, run jobs

Mail: `php artisan make:mail`, queue it (`implements ShouldQueue`); development mail lands in
Mailpit (http://localhost:8025). Jobs: `make:job`, `dispatch(...)->afterCommit()`. The `queue`
service runs `queue:work`; the `scheduler` service runs `routes/console.php` (`Schedule::command(...)`).

## Verify email / two-factor / passkeys

Enable the feature in `config/fortify.php`, implement `MustVerifyEmail` on `User`, add its views in
`app/Features/Accounts` and tests. Each is a Fortify feature, not new code.

## Move to a modular monolith

See `docs/ARCHITECTURE.md`. The short form: each feature already owns its provider-free folder;
add `<Feature>ServiceProvider`, move its routes beside it, and let `ArchitectureTest` forbid
cross-feature imports except through a small public `Contracts` folder.

## What not to do

- No query for "my rows" outside `ListItems`-style actions; no `where('user_id', $request->input(...))`.
- No `{!! !!}` in Blade, no `DB::raw`/`whereRaw` with request input, no `$guarded = []`.
- No `env()` outside `config/*.php`; no secrets in code, tests (except obvious fakes) or the image.
- No logic in controllers or Livewire components beyond validate, authorise, call an action.
- No closures in `routes/*.php` (`route:cache` runs at container start).
- No lowering PHPStan's level or the coverage gate to get green.
