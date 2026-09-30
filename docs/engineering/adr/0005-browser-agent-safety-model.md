# 0005 — Browser agent safety: hand off human checks, never see or fill secrets, approvals for consequential actions

- **Status:** Accepted (0.27.0 AI browser, extended in 0.28.0; backfilled 2026-09-30)
- **Deciders:** owner
- **Related:** [security.md](../security.md); [ADR 0006](0006-credential-broker.md)

## Context

The desktop app has a real browser (`WebContentsView`, partition
`persist:aico-browser`) that the agent drives through CDP with trusted input
(`desktop/electron/browser.ts`, `browser_*` MCP tools). Pages are untrusted
content; the user's logged-in sessions, passwords and payment details are the
assets; and a model driving a browser can be manipulated by what it reads.

## Decision

1. **Human checks are handed off, never solved.** `detectHumanCheck`
   (`desktop/electron/browser-safety.ts`) recognises reCAPTCHA, hCaptcha,
   Turnstile, Arkose and DataDome frames, challenge text and titles; the
   action gate in `browser.ts` refuses to act while one is present and directs
   the agent to `browser_handoff`. AICO never solves, bypasses or works around them.
2. **Sensitive fields are never filled by the agent.** `classifySensitiveField`
   (type, `autocomplete` such as `cc-number` / `one-time-code`, names) marks
   passwords, card numbers/expiry/CVV, one-time codes and PINs; the fill tools
   refuse ("the user must enter it") and autofill skips them.
3. **The agent never sees stored secrets.** The browser password vault
   (`browser-vault.ts`, sealed with Electron `safeStorage`) gives nothing to the
   engine, the copilot, the model, the MCP browser tools, logs, insights or
   backups; `browser_evaluate` is refused on a page where AICO filled a
   password. Passwords are imported only from a CSV the user exports and picks
   (`browser-import.ts`) — other browsers' credential stores are never read or decrypted.
4. **Approvals for consequential actions**, through `confirm()` in main:
   closing more than one tab, every file upload, agent downloads of
   executables or risky files, site permissions (default "ask").
5. **Protected browsing**: look-alike / brand-in-subdomain /
   credential-over-http pages are stopped before load and are look-only for
   the agent (`browser-privacy.ts`); shields (HTTPS-first, third-party cookies
   blocked, GPC/DNT) in `browser-shield.ts`.

## Alternatives considered

| Option | Why not |
|---|---|
| Let the agent solve CAPTCHAs | bypasses a site's human verification; unacceptable |
| Let the agent fill saved passwords | the model would hold, and could leak, the value |
| Read other browsers' password stores for import | decrypting another application's credential store is not something AICO does |

## Consequences

- **Good:** the agent can browse, read and fill ordinary forms; the user stays
  in control of identity, payment and human verification.
- **Costs:** some flows stop for the user by design.
- **Known gap — not yet enforced in code:** submitting forms that buy, pay,
  book, send, post or delete is governed by an MCP instruction ("ask the user
  before submitting…", `desktop/electron/mcp.ts`) plus checkout-page hints in
  `browser-extract.ts`, not by a gate. By [principle 2](../principles.md#2-enforce-in-the-loop-not-in-the-prompt)
  this should move into the action gate; tracked as a follow-up.

## Verification

`npm --prefix desktop test`: `test-unit.mjs` (browser-safety), `test-browser-shield.mjs`
(170), `test-browser-tabs.mjs`, `test-browser-import.mjs` ("password, card,
CVC and one-time-code fields are never filled"; "report: carries ids and
reasons, never passwords").
