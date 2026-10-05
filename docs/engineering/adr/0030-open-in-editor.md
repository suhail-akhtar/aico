# 0030 — Let the engine open a project file in the person's editor, on a person's click; otherwise show it in the client's own viewer

- **Status:** Accepted (2026-10-05)
- **Date:** 2026-10-05
- **Deciders:** owner (asked for web "Open in editor": VS Code or the configured editor via `execFile`, path validated inside a project root, person-initiated only behind the human gate, with the web client's own viewer as the fallback; "Open in external editor" in the desktop)
- **Supersedes / related:** [0028](0028-code-graph.md) (the Code map's file links); [0027](0027-shell-confinement.md) (no shell, argument arrays); `src/server/decision-gate.ts` (`checkHuman`); `src/settings-project-policy.ts` (user-only keys)

## Context

The desktop opens a file at a line in its built-in editor from the Code map,
the Git page and file cards. The web client could not: a browser page cannot
start a program, so every "open" in the web Code map was missing and file
cards offered only "copy the path". People running `aico serve` work in an
editor already (VS Code, Cursor, a JetBrains IDE, Sublime); the engine runs on
the same machine and can start it.

Starting a process is the most dangerous thing a route can do. The vault's
threat model (docs/security/credential-broker.md §1) assumes the model can
`curl` the loopback port and may learn the API token, so the token alone must
never be enough to make the engine run a program — and nothing in a request
may choose *which* program.

## Decision

1. **`POST /api/editor/open { path?, file, line?, col? }`** (`src/server/editor.ts`):
   - **A person, not the token:** `checkHuman` (decision-gate) first — the
     desktop's one-time grant (`/api/editor/open` is in `HUMAN_ROUTES`,
     `desktop/electron/protocol.ts`) or the web client's UI-key nonce
     (`postAsPerson`). Refused before anything else is read.
   - **Only files of registered projects, by real path:** the project must be
     registered (`isKnownProject`), or for an absolute file, the registered
     project containing it; the file's real path (symlinks resolved) must lie
     inside the project's real path and be a regular file.
   - **The program is the person's:** `editor.command` from their own settings
     file only (`editor` is `user-only` in `PROJECT_POLICY`; a repository's
     `.aico/settings.json` cannot set it), else `code` (VS Code) found on the
     PATH. `{file}`, `{line}`, `{col}`, `{root}` are filled in; well-known
     editors get their line syntax when the command has no placeholders.
   - **No shell:** `spawn(program, args)` with `shell: false`. On Windows a
     `.cmd`/`.bat` launcher (which `code` is) can only run through `cmd.exe`:
     every word is double-quoted and a word containing a character `cmd` still
     interprets inside quotes (`"`, `%`, `!`, a line break) is refused — the
     viewer opens instead. The child is detached, its output ignored.
   - No editor, or a refused path: `{ opened: false, reason, fallback: 'viewer' }`.
2. **`GET /api/editor/file?path=&file=`** — the web viewer's source: the same
   project/real-path confinement, text only (a NUL in the first 8 KB means
   binary), at most 2 MB, and never a file that looks like credentials (the
   `Git` tool's `looksLikeSecretPath`: `.env*`, keys, `credentials.json`…).
3. **The web client** (`web/src/file-open.ts`) asks the engine and, when it
   cannot open an editor, shows `components/FileViewer` at the line (numbered,
   the line highlighted, "Copy path", "Open in editor" to retry, the reason
   and how to set `editor.command`). The Code map, and file cards in answers
   (`shared/ui/rich/Files` through `window.aicoOpenFile`), use it.
4. **The desktop** keeps its built-in editor and adds **Open in external
   editor** (Code map file rows, the editor toolbar and its context menu) —
   the same route, with the desktop's grant.
5. Both routes are classified in `scripts/security/routes.json`
   (`editor/open`: token+human) and attacked by the DAST suite (human gate,
   traversal through every parameter, a `.env` canary).

## Alternatives considered

| Option | Why not |
|---|---|
| `vscode://file/…` links from the browser | Works only for VS Code with its URL handler registered, opens on the *browser's* machine (wrong for a remote portal), and gives no way to know it failed — no fallback. |
| Let the client name the program (`?editor=idea`) | A request choosing the program is a command-execution primitive for any token holder. The person's settings choose. |
| Run the configured command through a shell (`exec`) | Shell metacharacters in a file name (`&`, `;`, `$()`) would execute. Argument arrays; the one forced `cmd.exe` case quotes and refuses. |
| Token-only (no human gate) | The token is a client credential the model may learn; launching must take a person (the same rule as approving a tool call). |
| A full editor in the web client | The agent and the person's own editor change files; the web viewer only shows code. Monaco is already the desktop's; the web bundle does not carry it. |
| Let the viewer return any file (incl. `.env`) | The viewer is for source code. A credentials file opens in the person's editor, where they can see it — never over HTTP. |

## Consequences

- **Good:** every file link in the web Code map opens the code — in the
  person's editor when there is one, in the viewer otherwise; the desktop can
  jump to the external editor; nothing new runs without a click.
- **Bad / costs:** a second way to read project files over the API (bounded as
  above); a launch path that differs on Windows (`cmd.exe` for batch
  launchers).
- **Honest limits:** the editor starts on the **engine's** machine — a portal
  opened from another computer (a tunnel) starts it there, not where the
  browser is; the viewer is the right choice then, and the answer's reason
  says nothing opened if the program is missing. A Windows path with `%` or
  `!` cannot go through a batch launcher safely and falls back to the viewer
  (an `.exe` editor command has no such limit). VS Code's own "open folder vs
  file" heuristics apply (`-g` reuses a window).
- **Migration:** none; a new user-only setting `editor.command`.

## Threat model

- **Assets:** the person's machine (process execution), project files.
- **Actors:** a model or a process that learned the API token; a cloned
  repository's settings; a crafted file name.
- **Controls:** human gate before any input is read (`editor/open`); program
  only from user settings or PATH lookup of `code`; no shell (argument array;
  quoted + refused characters for the Windows batch case); real-path
  confinement to registered projects; viewer: text, size, credentials-path
  refusal; both routes require the startup token and same-origin like every
  route.
- **Residual risk:** a same-user process that can read the printed link (token
  + UI key) is the person for the gate's purposes (decision-gate's stated
  residual risk). A person who sets `editor.command` to a harmful program
  runs it on their own click.

## Verification

- `scripts/editor-test.mjs` (in `npm test`): command parsing and placeholders,
  PATH lookup, the gate refusing the token alone with a real `DecisionGate`,
  `..`/absolute/symlink/unregistered-project refusals, a **real launch** of a
  fake `code` on a private PATH that records its arguments (on Windows through
  the quoted `cmd.exe` path with a space in the file path), `%` refused, the
  viewer's refusals.
- `scripts/security-dast.mjs`: `editor/open` with the token alone is refused;
  traversal through `path` and `file` of `editor/file`; the `.env` canary is
  never returned; a control read succeeds.
- Live: the web Code map's open falls back to the viewer at the line when no
  editor is on the PATH (screenshot in the change's evidence).
