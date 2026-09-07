# __APP_TITLE__

__APP_DESCRIPTION__

An LLM-powered service on [Hono](https://hono.dev): a tool-calling agent loop
over any OpenAI-compatible model, conversations kept in Node's built-in SQLite,
answers streamed over server-sent events. The tests use a scripted model, so
they need no key.

## Run

```sh
npm install
cp .env.example .env            # set MODEL_BASE_URL, MODEL_API_KEY, MODEL
npm run dev                     # http://localhost:3000
```

```sh
curl -s -X POST localhost:3000/conversations                       # → { "id": … }
curl -s -X POST localhost:3000/conversations/<id>/messages \
  -H 'content-type: application/json' -d '{"text":"what is 12.5 * 4?"}'
curl -N -X POST localhost:3000/conversations/<id>/messages \
  -H 'content-type: application/json' -H 'accept: text/event-stream' -d '{"text":"and now?"}'
```

## Check

```sh
npm run typecheck
npm test
npm run build && npm start
```

## Configure

| Variable | Default | Meaning |
|---|---|---|
| `MODEL_BASE_URL` | `https://api.openai.com/v1` | any OpenAI-compatible endpoint (OpenRouter, DeepSeek, Kimi, Ollama…) |
| `MODEL_API_KEY` | | the key; empty is allowed for a local endpoint |
| `MODEL` | `gpt-4o-mini` | model id |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | listen |
| `DATABASE_PATH` | `./data/app.sqlite` | SQLite file |

## Deploy

`deploy/README.md`. `node deploy/docker.mjs` builds the image; pass the model
variables as env and mount `/app/data`.

## Structure

```
src/model.ts    one call to the model, fetch injectable
src/tools.ts    the tools; calculate is the worked one
src/agent.ts    the loop: ask, run tools, ask again, answer
src/store.ts    conversations in SQLite
src/app.ts      routes, JSON or SSE
test/           the scripted model
```
