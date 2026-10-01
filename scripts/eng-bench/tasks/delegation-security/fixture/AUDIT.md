# Security review — platform-libs 0.9.0

External review, findings ranked by severity. Each package is owned and released independently;
none of them imports another.

| # | Package | Severity | Finding |
|---|---|---|---|
| F1 | `packages/safe-path` | High | `resolveUserFile(root, name)` can be made to resolve outside `root` (path traversal). Used by the attachment download endpoint with a user-supplied file name. |
| F2 | `packages/user-query` | Critical | `findUsers(db, { name, sortBy })` builds SQL from caller input. Both the name filter and the sort column come from query-string parameters. |
| F3 | `packages/session-token` | High | `verifyToken(token, secret)` accepts tokens past their `exp`, and compares signatures in a way that leaks timing information. |
| F4 | `packages/redirect-guard` | Medium | `isSafeRedirect(target)` is meant to allow only same-site relative paths after login, but some external targets pass. |
| F5 | `packages/html-render` | High | `renderComment(comment)` output is inserted into pages as HTML; user-controlled fields are not neutralised (stored XSS). |

Fix requirements from the review board:

- Keep every package's exported functions and their signatures as they are; callers must not change.
- Invalid or hostile input must be rejected (return `null` / `false` / throw, as each package already does for its other error cases) — never crash with an unrelated exception.
- Each finding needs at least one regression test in that package's test file.
