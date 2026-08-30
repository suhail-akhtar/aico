/**
 * What a full-stack Mini App author is told.
 *
 * The single-page contract can promise a lot because the server is fixed: the
 * page cannot send SQL, cannot define an endpoint, cannot run anything. None of
 * that is true here. A Next.js Mini App *is* server code, so this brief spends
 * its words differently — less on what is provided, more on what the author is
 * now responsible for, because they are the ones writing the parts that used to
 * be guaranteed.
 *
 * @module miniapps/contract-nextjs
 */

/** The authoring brief for a Next.js Mini App. */
export function nextAuthoringContract(slug: string, dir: string): string {
  return `Next.js Mini App "${slug}"

  Directory  ${dir}
  Started by aico on a free port; the URL appears once it is running.

This is a real Node application. It has its own server, its own dependencies
and its own process — which means the guarantees a single-page Mini App gets
for free are now yours to keep.

── Scaffold it yourself, do not run create-next-app ────────────────────
The scaffolder is interactive, downloads a template, and takes minutes.
Write the handful of files directly; it is faster and you control what
lands.

  package.json      next, react, react-dom. Nothing else unless it is
                    genuinely needed — every dependency is time on the
                    first run and surface you did not review.
  next.config.mjs
  tsconfig.json     if you use TypeScript, which you should
  app/layout.tsx    the shell
  app/page.tsx      the first screen
  app/globals.css
  lib/db.ts         the database, opened once (see below)
  .env.local        DATABASE_URL, when it is not the default

Dependencies are installed on first run. Keep the list short.

── The database ────────────────────────────────────────────────────────
Default to SQLite through Node's built-in driver. No dependency, no
native build, and the file sits beside the app where it can be inspected:

  import { DatabaseSync } from 'node:sqlite';
  const db = new DatabaseSync('data.sqlite');

Open it ONCE per process and export the handle. A module that opens a
connection per request will exhaust file handles under any real use, and
the failure arrives long after the code that caused it.

If DATABASE_URL is set, honour it instead — Postgres or MySQL — and put
it in .env.local, never in a file you commit and never in aico's
settings. It is the app's credential, not the agent's.

Write the schema as migrations the app applies at startup, idempotently.
The same rule as the single-page apps and for the same reason: startup
runs more than once.

── What you are now responsible for ────────────────────────────────────
A single-page Mini App cannot write a bad query, because it does not
write queries. You can. So:

  · PARAMETERISE EVERY QUERY. Never concatenate a value into SQL, not
    even one you are sure of, not even an id you just generated.
  · VALIDATE ON THE SERVER. A server action or route handler is a public
    endpoint. Client-side checks are a courtesy to the reader, not a
    control.
  · CHECK WHAT COMES BACK. A row that does not exist is a normal Tuesday,
    not an exception to leave uncaught.
  · SAY WHAT WENT WRONG. An error boundary that renders "Something went
    wrong" is a dead end; name the operation that failed.

── The environment you run in ──────────────────────────────────────────
The process is started with credentials stripped: no API keys, no aico
token. Do not look for them, and do not ask the reader to paste one into
a file — if the app needs a third-party service, say so and stop.

It runs on its own port, which makes it its own origin. It cannot reach
aico and aico does not reach into it.

── The bar for the interface ───────────────────────────────────────────
Higher than a single-page app, not lower, because you have components
and routing to work with.

  · LEAD WITH THE ANSWER. The first screen states what the reader came
    to find out, before any table or toolbar.
  · ONE PRIMARY ACTION per screen. Everything else recedes.
  · REAL LOADING AND EMPTY STATES. Use Suspense and a skeleton that holds
    the layout; write an empty state that says what to do next.
  · SERVER COMPONENTS BY DEFAULT. Reach for "use client" only where you
    genuinely need interactivity — a page that ships the whole app to the
    browser to render a list is slower for no reason.
  · FORMS THAT SURVIVE A FAILURE. Keep what was typed, show the error
    beside the field, never silently discard input.
  · NUMBERS TABULAR AND RIGHT-ALIGNED, currency formatted, dates
    readable.
  · KEYBOARD AND FOCUS WORK. Labels tied to inputs, visible focus,
    Escape closes a dialog.
  · DARK MODE, via prefers-color-scheme, chosen rather than inverted.

Restraint is doing real work: colour belongs to the data — a status, an
overdue amount — and every accent spent on chrome is one the data cannot
use.

── Before you call it done ─────────────────────────────────────────────
Start it (the reader can, from the Mini Apps panel), open it, and click
through it. A Next.js app that compiles is not an app that works, and
the first thing a reader does is exactly the thing you did not try.`;
}
