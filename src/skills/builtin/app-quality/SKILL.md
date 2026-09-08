---
name: app-quality
description: Prove a feature works before calling it done — RunChecks, a VerifyApp check per requirement in the user's words, dead code and console noise removed, accessibility basics, and a report of exactly what was verified. Use when asked to test, verify, QA, review or finish a feature or app.
author: aico
version: 1.0.0
trigger: \b(verify|qa|test (it|this|the (app|feature|page))|make sure it works|is it done|finish(ed)? the (app|feature)|quality|polish)\b
---
The question is not "does it look right" but "was it seen working". Answer it with evidence. {args}

## 1. The project's own checks

`RunChecks`. Typecheck, lint, test and build must be green on the code as it is now, not as it was before the last edit. A red check is the first thing to fix, whatever else was asked.

## 2. One browser check per requirement, in the user's words

For a served app: `AppManage start` if it is not running, then `VerifyApp` on the URL with a `checks` list. Each check is named after a requirement as the user phrased it ("mark an invoice paid", "sign in with the wrong password is refused") and drives the interaction — click, type, submit — and asserts what the user would see. Loading is not working: a page with controls and no interaction checks proves nothing. For a page app, verify the file URL the same way. For a CLI, a passing test run is the check.

## 3. Read what the browser said

Console errors, failed requests, and unhandled rejections in the verdict are defects even when the check passed. Fix them; verify again. A verdict from before the fix is not evidence.

## 4. Tidy the trail

- Remove dead code, commented-out blocks, unused imports and `console.log` left from debugging.
- Grep for `Placeholder` and `lorem`: templates mark what to write with them, and none may reach a user.
- Every form control has a label; every image `alt`; focus is visible; Escape closes a dialog; Enter submits a form; the page survives a 390px viewport.
- Error states say what is wrong, where it is wrong, in words a user would use.

## 5. Tick and record

Tick each story in `.aico/backlog.md` whose "Done when" was observed — only those. Update TodoWrite to match. Add a CHANGELOG line if the project keeps one.

## 6. Report exactly what was verified

Finish with a short list: each requirement, the check that covered it, and its result — plus anything not covered and why. Never write "everything works"; name the checks.

## Do not

- Substitute reading the source for running it.
- Write checks that only load the page when it has controls to exercise.
- Delete a failing test to make the suite green; fix the code or say the test is wrong and why.
- Claim coverage of a requirement no check exercised.
