---
name: security-review
description: Defensive security analysis with OWASP Top 10 coverage and severity scoring
author: aico
version: 2.0.0
aliases: [sec, secaudit]
---
Perform a comprehensive defensive security audit of the codebase or specified scope.

Scope: {args} (default: current working directory)

**Read the actual source code** before reporting findings — do not audit from assumptions. Use `Read`, `Grep`, and `Glob` to inspect the files in scope. Run `npm audit` / `pip audit` / `cargo audit` if a dependency file is present.

If the codebase is large, use the Task tool with subagent_type "security-audit" to delegate focused scans.

## Analysis checklist (OWASP Top 10 + extras)
1. **Injection** — SQL, NoSQL, OS command, LDAP injection.
2. **Broken Authentication** — weak passwords, missing rate limiting, session fixation, weak JWT config.
3. **Sensitive Data Exposure** — hardcoded secrets, unencrypted PII, weak crypto, secrets in git history.
4. **Security Misconfiguration** — open CORS, debug endpoints, default credentials, missing security headers.
5. **XSS** — reflected, stored, DOM-based (dangerouslySetInnerHTML / v-html / innerHTML).
6. **Insecure Deserialization** — unsafe JSON.parse of untrusted data, eval, prototype pollution.
7. **Vulnerable Dependencies** — run the appropriate audit tool; check lockfile integrity.
8. **Insufficient Logging & Monitoring** — missing audit trails for sensitive operations, secrets logged.
9. **SSRF** — user-controlled URLs fetched server-side without validation.
10. **Broken Access Control** — missing authz checks, IDOR, privilege escalation.
11. **Cryptography** — weak algorithms (MD5/SHA1), hardcoded IVs/keys, Math.random for security.

## Severity rubric (use EXACTLY these levels — consistent across the whole system)
- **CRITICAL** — exploitable vulnerability, data loss, or remote code execution.
- **HIGH** — likely exploitable security weakness or data integrity risk.
- **MEDIUM** — security concern in a non-critical path, or configuration risk.
- **LOW** — minor hardening opportunity.
- **INFO** — best-practice observation with no defect.

## Evidence requirement
Every finding MUST include file:line and the offending code snippet. Findings without a location are invalid — discard them. Do a false-positive filtering pass: only report findings you are confident about and would defend.

## Output format

## Security Score: X/10 (10 = no issues)

## Critical Findings
For each: `**[CRITICAL]** file:line` — description — impact — remediation (with code snippet)

## High Findings
...

## Medium / Low / Info Findings
...

## Dependency Vulnerabilities
Audit tool output summary with CVE IDs where available.

## Summary
`CRITICAL: N | HIGH: N | MEDIUM: N | LOW: N | INFO: N`
Top 3 immediate actions.
