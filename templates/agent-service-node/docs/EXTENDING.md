# Extending this agent

## Add a tool (the main move)

1. Copy `calculator` in `src/tools.ts`: a `schema` (name, one-sentence description
   that says *when* to use it, JSON-schema parameters) and `run(args)`.
2. Validate every argument. Return errors as strings starting `Error:` — the model
   reads them and recovers; a thrown exception ends the request.
3. Add it to `TOOLS`.
4. Test it two ways in `test/`: `run()` directly, and through `runAgent` with a
   scripted model that calls it, checking the result was fed back.

Keep tools narrow. "search the knowledge base" beats "do anything with the database".

## Change the model

Set `MODEL_BASE_URL`, `MODEL_API_KEY`, `MODEL`. Ollama: `http://localhost:11434/v1`
and any model name, key empty. A provider that is not OpenAI-shaped gets a second
`complete` implementation in `src/model.ts` behind the same signature.

## Add retrieval (RAG)

A tool: `search_docs({ query })` that reads your index and returns the top passages
as text. The loop needs no change. Keep the index build outside the request path.

## Stream tokens, not just steps

`complete()` is non-streaming on purpose (simplest correct loop). To stream the
final answer token by token, add `stream: true` to the last call only, and pipe
deltas to the SSE as `delta` events; keep tool steps as they are.

## Add memory across conversations

A `memories` table and two tools (`remember`, `recall`) — the model decides what
is worth keeping, the tools decide what is allowed.

## What not to do

- No domain knowledge in the system prompt; put it in tools or retrieval.
- No unbounded loop; keep `maxSteps`.
- No key in code, logs, or error messages.
- No tool that runs arbitrary shell or SQL from model arguments.
