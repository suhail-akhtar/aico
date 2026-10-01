# helpdesk

The support team's ticket desk. No framework and no npm dependencies: Node's `http`
module, `node:sqlite`, and a static page with plain JavaScript.

```
npm start          # http://localhost:3000  (PORT and DB_PATH env vars override)
npm test
```

## Layout

| Path | What |
|---|---|
| `server.js` | HTTP server: JSON API under `/api`, static files from `public/` |
| `src/db.js` | Opens the SQLite database and applies `migrations/*.sql` in order (tracked in `schema_migrations`) |
| `src/tickets.js` | Ticket queries |
| `src/http.js` | JSON helpers and the error shape |
| `public/` | The single-page UI (`index.html`, `app.js`, `styles.css`) |
| `migrations/` | Numbered SQL migrations — never edit one that has shipped; add a new file |
| `test/` | API tests (`node --test`), each starting the server on a free port with a temp database |

## API

Errors are always `{ "error": { "code": "...", "message": "..." } }` with codes
`validation_error` (400), `not_found` (404), `internal` (500).

| Method | Path | Body | Result |
|---|---|---|---|
| GET | `/api/tickets` | | `200` array of tickets, newest first |
| POST | `/api/tickets` | `{ title, description?, priority? }` | `201` ticket |
| GET | `/api/tickets/:id` | | `200` ticket |
| PATCH | `/api/tickets/:id` | `{ status }` — `open` \| `pending` \| `closed` | `200` ticket |

## UI conventions

Elements the end-to-end checks use carry `data-testid` attributes; keep them stable.
