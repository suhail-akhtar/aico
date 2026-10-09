# Connector pack format (reference)

## connector.json

```json
{
  "format": 1,
  "id": "acme-tracker",
  "label": "Acme Tracker",
  "provider": "Acme Tracker",
  "baseUrl": "https://api.acme-tracker.example",
  "hosts": ["api.acme-tracker.example"],
  "auth": { "scheme": "bearer", "help": "Create an API key under Settings, API." },
  "capabilities": { "items": { "estimate": "none" } },
  "operations": {
    "probe": {
      "tool": "acme_whoami", "effect": "read",
      "result": { "map": { "user": "/name", "version": "/apiVersion" } }
    },
    "items.query": {
      "tool": "acme_list_issues", "effect": "read",
      "args": { "state": "{state}", "label": "{value}", "updatedSince": "{since}" },
      "result": {
        "list": "/data/issues",
        "map": { "id": "/id", "number": "/number", "title": "/title", "body": "/description", "state": "/status",
                 "labels": "/labels", "assignees": "/assignees", "author": "/creator/name", "url": "/url", "rev": "/updatedAt" },
        "values": { "state": { "map": { "Backlog": "open", "In Progress": "open", "Done": "closed" }, "default": "open" } }
      },
      "pagination": { "style": "cursor", "cursorPath": "/data/next", "param": "cursor", "maxPages": 5 }
    },
    "items.comment": { "tool": "acme_comment", "effect": "external", "args": { "id": "{id}", "text": "{body}" } }
  }
}
```

- `auth.scheme`: `bearer`; `basic` (needs `username`); `header` (needs `header`, e.g. `X-Api-Key`). Never a query parameter.
- `args` maps the operation's inputs (`{id}`, `{body}` ...) to the tool's parameters. A whole-value `"{x}"` keeps its type; an input that is absent drops the parameter. Every repository-scoped operation (pulls.*, items.*, checks.*) also gets `owner` and `name` of the mapped repository as inputs. Inputs per operation: probe: none; repos.get: owner, name; pulls.find: head; pulls.create: head, base, title, body, draft; pulls.get and pulls.comments: id; pulls.comment: id, body; pulls.merge: id, method, sha; items.query: source, value, since, me, state; items.get: id; items.create: title, body, labels; items.update: id, title, body, ifRev; items.transition: id, to (`open` or `closed`), ifRev; items.comment: id, body; checks.forCommit: sha.
- `result.map` fields per kind (required ones first): probe user, version; repos.get defaultBranch, cloneUrl (https, one of `hosts`), htmlUrl, private, id; pulls.* id, state (`open`, `merged`, `closed`), url, draft, headSha, mergeable (`mergeable`, `conflicting`, `unknown`), canMerge, mergeBlockers (array of text), approved, changesRequested, requiredApprovals, mergedSha, and `result.checks` {list, map: name, state (`pending`, `success`, `failure`, `neutral`, `skipped`), url, summary}; pulls.comments id, body, author, association (`OWNER`, `MEMBER`, `COLLABORATOR`, `NONE`), at, review; items.* id, title, state (`open` or `closed`), number, body, labels, assignees, author, url, rev, points; checks.forCommit name, state, url, summary.
- `values.<field>.map` turns the platform's raw values into the normalised ones (case-insensitive); `default` applies when nothing matches.
- `pagination`: `link` (Link header), `cursor` (`cursorPath`, `param`), `page` (`param`). `maxPages` up to 10.
- `mcpServers` plus `"mcp": {"server": "...", "tool": "..."}` in place of `tool`, for what HTTP cannot express.

## tools/acme_list_issues.tool.json

```json
{
  "name": "acme_list_issues",
  "description": "List issues, newest first.",
  "input_schema": { "type": "object", "additionalProperties": false,
    "properties": { "state": { "type": "string", "enum": ["open", "closed", "all"] }, "label": { "type": "string", "pattern": "^[A-Za-z0-9 _.:-]{1,80}$" }, "updatedSince": { "type": "string", "pattern": "^[0-9T:.Z-]{10,40}$" } },
    "required": ["state"] },
  "http": { "method": "GET", "url": "https://api.acme-tracker.example/v1/issues?state={state}&label={label}&updated={updatedSince}" },
  "effect": "read"
}
```

`{field}` in the URL is URL-encoded. Header values are literal. The credential is applied by AICO from the connection's own vault record; never write one.

## fixtures/items.query.json

```json
{
  "operation": "items.query",
  "cases": [{
    "name": "open issues",
    "input": { "source": "label", "value": "bug", "state": "open" },
    "request": { "method": "GET", "path": "/v1/issues", "query": { "state": "open", "label": "bug" } },
    "response": { "status": 200, "body": { "data": { "issues": [{ "id": "A-1", "number": 1, "title": "Login fails", "status": "Backlog", "labels": ["bug"], "assignees": [], "creator": { "name": "sam" }, "url": "https://app.acme-tracker.example/A-1", "updatedAt": "2026-10-01T10:00:00Z" }], "next": null } } },
    "expect": [{ "id": "A-1", "title": "Login fails", "state": "open", "labels": ["bug"] }]
  }]
}
```

`expect` is a subset of the normalised result (a list must have the same length). `{"error": {"code": "not-found", "status": 404}}` asserts a failure. `next: [{request, response}]` serves following pages. An MCP-backed operation's case supplies the tool result as `response.body`.
