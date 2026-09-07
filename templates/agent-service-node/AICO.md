# __APP_TITLE__

An LLM-powered service: a Hono API around a tool-calling agent loop, over any
OpenAI-compatible model (`MODEL_BASE_URL`, `MODEL_API_KEY`, `MODEL`), with
conversations in node:sqlite and answers streamed over SSE. Tests run the whole
loop against a scripted model — no key, no network.

## Layout

- `src/model.ts` — `complete(config, messages, tools)`: one non-streaming call over
  `/chat/completions`; `fetch` injectable. Add providers here only if they are not OpenAI-shaped.
- `src/tools.ts` — **the worked tool** (`calculate`) and the `TOOLS` table. A tool is a
  schema plus `run(args) → string`; validate args, return errors as text.
- `src/agent.ts` — `runAgent(history, text, opts)`: bounded loop, tool results always
  fed back, events for a listener. `SYSTEM_PROMPT` lives here.
- `src/store.ts` — conversations as rows with a JSON transcript; migrations append-only.
- `src/app.ts` — routes: `/conversations`, `/conversations/:id/messages` (JSON or SSE
  with `Accept: text/event-stream`), `/healthz`, `/readyz`.
- `test/agent.test.ts` — the scripted model (`scriptedModel`) is how everything is tested.

## Conventions

- Tool errors are strings starting `Error:` — the model reads them and recovers.
- Never trust tool arguments; parse and validate in the tool.
- The system prompt is short and says when to use tools; put domain knowledge in tools
  or retrieval, not in the prompt.
- Config from env only; the key is never logged.

## Checks

`npm run typecheck`, `npm test`, `npm run build`. Then `AppManage start` and
`VerifyApp` `/healthz`; a real model answer needs `MODEL_API_KEY` in `.env`.
