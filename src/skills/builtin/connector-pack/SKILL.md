---
name: connector-pack
description: Builds a connector pack so AICO can work with a forge or tracker it has no built-in adapter for (Linear, YouTrack, Phabricator, an in-house tool), from its OpenAPI document or docs, then tests it. Use when asked to connect, integrate or add a platform that is not GitHub, GitLab, Azure DevOps, Bitbucket, Gitea or Forgejo.
author: aico
version: 1.0.0
trigger: \b((connect|integrate|add|build|write|make)( \w+){0,4} (connector|integration|adapter)|connector pack|(connect|integrate)( \w+){0,3} (linear|jira|youtrack|phabricator|clickup|asana|redmine|trello|shortcut)|no (built-?in )?adapter)\b
---
A connector pack is data plus HTTP tools AICO already trusts, never code. You write it, replay recorded fixtures against it, and a person reviews and enables that exact content. You cannot enable it or store a token, and any later edit switches it off until a person approves again. {args}

## 1. Find out what the platform offers

- Read the OpenAPI/Swagger document or API docs the person gave (WebFetch the URL, or `Read` a file). Note the base URL, how a token is sent (Bearer, Basic, or one header), and the paging style.
- Pick only what AICO uses; ignore the rest. Operations (all optional except `probe`): `probe` (who am I), `repos.get`, `pulls.find|create|get|comment|comments|merge`, `items.query|get|create|update|transition|comment`, `checks.forCommit`. A tracker with no pull requests needs just `probe`, `items.query`, `items.get`, and perhaps `items.comment`.
- Ask the person for anything you cannot read: the base URL, which project or team to import from. Never ask them to paste a token to you; they add it on the Connections page.

## 2. Write the pack in the project (a scratch folder)

Lay out `connectors/<id>/` (id: lower-case letters, digits, `-`):

- `connector.json`: `format: 1`, `id`, `label`, `provider`, `baseUrl`, `hosts` (the closed list of hosts; no wildcards), `auth` (`bearer`, `basic` with `username`, or `header` with a header name; a token never goes in a URL), and `operations`. Field shapes, value maps, paging and an example: `references/format.md`.
- `tools/<name>.tool.json`: one ADR 0009 `http` tool per request (`name`, `description`, `input_schema` with `additionalProperties:false`, `http` {method, url, optional literal headers, body}, `effect`). Every URL host must be in `hosts`. No `run`, no `{{secret...}}`, no placeholder in a header or in the host.
- `fixtures/<operation>.json`: `{"operation": "...", "cases": [{name, input, request:{method,path,query?,bodyIncludes?}, response:{status, body}, expect}]}`. Take the response bodies from the docs' examples or from a read-only call the person approved; scrub names and tokens.

Rules the engine enforces (not just advice):

- **Mapping is JSON pointers only** (`/data/title`) or `{"const": ...}`. No expressions. Enums go through `values` maps; a value the map does not cover is an error, not a guess.
- **Effect classes**: you declare one per operation (`read`, `external`, `destructive`); the applied class is the stricter of yours, the operation's (create/update/comment are external, merge/delete destructive) and the HTTP method's. A read must be GET; a search that needs POST sets `readOnlyPost: true`, which the person sees.
- **Anything that looks like a credential in any file is refused.**

## 3. Draft, validate, test

1. `ConnectionManage action:"draft" pack:"<id>" from:"connectors/<id>"` (or pass `connector`, `tools`, `fixtures` inline). It saves even when invalid and returns every error with the fix.
2. `action:"validate"` after edits; fix until there are no errors.
3. `action:"test-contract"`: replays each fixture through the real engine path on loopback and checks the normalised result. Fix a failing operation (the message names the first difference); an operation that fails or has no fixture stays off.

## 4. Hand over to the person

Say in plain words: the platform, the hosts it may contact, what it will be able to do, which operations write (and that merge needs their click), and that they should open Settings, Connections, Packs, read the review card, and press Enable. Then `action:"create" provider:"custom" pack:"<id>"` makes the connection; they paste the token and press Test. Do not call it done until they have, and say that any edit after enabling switches the pack off until they approve again.

## Limits to state honestly

A pack is weaker than a built-in adapter: no labels, no branch-protection read, no sprints, and one request per operation. A platform that signs requests, speaks RPC over one URL or returns XML needs an MCP server instead; name one tool of it in an operation with `mcp: {server, tool}` and list the server in `mcpServers`.
