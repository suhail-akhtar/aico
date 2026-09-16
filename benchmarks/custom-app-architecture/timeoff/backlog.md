# Backlog — DaysOff

Stories are vertical slices: migration → repository → route → screen → check.
Tick a box only when its "Done when" has been observed (a passing test, or a
VerifyApp check against the running app). Append iterations; never rewrite the
ones above.

## Iteration 1 — an employee asks for days off, a manager decides, the employee sees it

- [x] A person can say who they are and land on their own time off: their days
      left and their own requests, nobody else's.
      Done when: VerifyApp check "see my days left" — picking Ada shows her name,
      a days-left figure and her request list; a second person's requests are not
      in it.
- [x] An employee can request time off in working days, and it appears at once as
      Pending with the balance unchanged.
      Done when: VerifyApp check "request time off" — dates across a weekend store
      3 days, the row appears as Pending, days left stays put; and `npm test`
      passes the working-day and overlap cases, including an end before the start
      answering 400 with the field named.
- [x] A manager sees the pending requests of their direct reports, and nothing
      else — not their own, not another team's.
      Done when: VerifyApp check "manager queue is my team only" — in the manager
      view the queue lists only direct reports' pending rows.
- [x] A manager can approve or deny a request with a note; the row leaves the
      queue and the decision is stored with who made it.
      Done when: VerifyApp check "approve with a note" — after approving, the
      queue no longer lists it; and `npm test` passes the 403 for deciding
      someone who is not your direct report.
- [x] The employee sees the outcome: the status, the note, and the corrected
      balance — days left drops by the approved days, and not at all for a denial.
      Done when: VerifyApp check "employee sees the outcome" — the employee's row
      reads Approved with the manager's note and days left is lower by exactly
      those days.

## Later

- Half days and hours rather than whole days.
- Company holiday calendar, so working-day counts skip public holidays.
- Carry-over and accrual across the year boundary.
- Cancel or edit a request that is still pending.
- SSO in place of the identity picker.
