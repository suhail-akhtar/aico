# Decisions — __APP_TITLE__

One line per decision: what, and why. Append; do not edit old lines. Compaction
keeps this file when it drops the transcript.

- One OpenAI-compatible client with an injectable `fetch` — covers OpenAI, OpenRouter,
  DeepSeek, Kimi, Ollama and most gateways, and lets the tests script the model.
- Tool errors go back to the model as text — a model that reads "Error: …" fixes its
  call; a model whose call vanished asks again forever.
- The loop is bounded (`maxSteps`) and reports events — a client can stream progress,
  and a runaway loop ends with a message rather than a bill.
- Transcript stored as JSON per conversation — the model's own message format, no
  second schema to keep in step with it.
- SSE for streaming rather than WebSockets — one-directional, works through every
  proxy, and `curl -N` can watch it.
