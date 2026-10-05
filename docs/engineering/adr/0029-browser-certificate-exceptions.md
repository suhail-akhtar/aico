# 0029 — Browser certificate exceptions: the person may proceed past a certificate warning, bound to that exact certificate

- **Status:** Accepted (2026-10-05)
- **Date:** 2026-10-05
- **Deciders:** owner (+ authors)
- **Supersedes / related:** amends [0005](0005-browser-agent-safety-model.md) (browser agent safety); [0006](0006-credential-broker.md) (the vault)

## Context

The AICO browser refused every invalid certificate ("AICO does not let you or
the agent continue to a site with a broken certificate"). The only way through
was a stored credential with `allowSelfSigned` on a private address. People
run internal consoles and development servers on a private CA or a
self-signed certificate — the owner's own example, an internal console,
fails with `ERR_CERT_AUTHORITY_INVALID` — and had to leave AICO to open them.
Chrome lets the person click through a warning; AICO had no such path.

The risk is real: clicking through is how a person is walked into an
intercepted connection, and AICO's browser also has an agent that can be
manipulated by what it reads, and a vault that fills passwords.

## Decision

1. **The warning stays, with "Advanced → Proceed to <host> (unsafe)".** The
   warning shows the error, the host, and under Advanced the subject, issuer,
   validity and SHA-256 fingerprint. Proceeding creates an exception for that
   **host + certificate fingerprint**: for this app session by default
   (memory), or persisted when the person ticks "Always trust this certificate
   for <host>" (browser `settings.json`, listed in Privacy & security →
   Certificate exceptions, removable). A different certificate for the same
   host shows the warning again. Rules: `desktop/electron/browser-certs-core.ts`.
2. **Only the person proceeds.** `browser:certProceed` answers only the AICO
   window's top frame (as every handler), must quote the token of the warning
   main is showing (main records the certificate; the renderer never supplies
   it), and needs a real input event on an `aico://app` window within 3 s.
   The agent drives tabs, never the AICO window, and no browser tool reaches
   these channels; `browser_open` tells it "the person must allow this
   certificate". Once the person allowed a host + fingerprint, the agent may
   use that host too.
3. **Localhost.** "Allow self-signed certificates on localhost" (default off,
   the person's own click to turn on — like Chrome's allow-insecure-localhost)
   lets loopback hosts (localhost, *.localhost, 127/8, ::1) through for the
   person and the agent.
4. **Never bypassable:** `ERR_CERT_REVOKED` and every error other than an
   authority, name, date or validity-length problem; hosts under HSTS — a
   small built-in subset of the preload list (HTTPS-only TLDs, a few
   preloaded sites) plus any host that sent `Strict-Transport-Security` over a
   valid connection (`hsts.json`, honouring max-age and includeSubDomains).
5. **On an excepted site:** the address bar shows a red "Not secure"; the
   vault never fills passwords and `browser_login` refuses on a session
   exception; on an "always" exception the person is asked once per host
   (AICO prompt) before saved passwords may be used there. The commit gate
   and every other rule of ADR 0005 still apply.
6. **Scope:** decided in the browser tabs' `certificate-error` handler, so it
   applies only to the browser's session partition — never to `aico://`
   pages or the engine's traffic. Removing an exception closes the
   partition's open connections so the next load is judged again.

## Alternatives considered

| Option | Why not |
|---|---|
| `setCertificateVerifyProc` returning OK for excepted certificates | the network service caches its result: a proceed would not take effect, and a removal would linger |
| Let the agent proceed (or ask the person through a tool) | a page can steer the agent; the decision must be the person's own click |
| Trust per host regardless of certificate | an attacker's certificate for the same name would be accepted silently |
| Query Chromium's full HSTS preload list | Electron exposes no API for it; a subset plus learned headers is the honest best |

## Consequences

- **Good:** internal and dev sites work in AICO, for the person and — after
  they allow it — the agent; the danger is visible and passwords stay out.
- **Costs:** the HSTS preload coverage is partial; a revoked certificate is
  detected only when Chromium reports `ERR_CERT_REVOKED`.

## Verification

`npm --prefix desktop test` → `scripts/test-browser-certs.mjs` (store,
decisions, proceed checks, password rule, no agent channel). Live: the desktop
under Playwright with an isolated `AICO_HOME` against a local self-signed
HTTPS server (warning, Advanced, a forged proceed refused, proceed, Not
secure badge, settings list, removal, localhost setting).
