# Verification checklist

## A VerifyApp check, well formed

```
{ name: "mark an invoice paid",
  steps: "open /invoices, click Paid on the first open row",
  expect: "the row's status pill reads paid and the Open total decreases" }
```

Named in the user's words. Drives an interaction. Asserts what is seen, not what the code does.

## What counts as a defect even when checks pass

- A console error or warning on load or during the flow.
- A failed network request (4xx/5xx) the page made.
- An unhandled promise rejection.
- Layout that overflows at 390px, or text that cannot be read in dark mode.
- A control with no accessible name; focus that disappears; a dialog Escape cannot close.

## The report

```
Verified
- mark an invoice paid — check "mark an invoice paid": PASS
- refuse a wrong password — check "wrong password refused": PASS
- overdue first — check "overdue sorted first": PASS (after fixing the sort key)
Not verified
- PDF export — not built in this iteration (backlog story 5)
Checks: typecheck, lint, test, build all green (RunChecks).
```

## Before ticking a story

The story's "Done when" names a check or a test. That check or test passed on the current code. Nothing else counts.
