# Backlog — __APP_TITLE__

Stories are vertical slices: schema → screen → checked in the browser. Tick a
box only when its "Done when" has been seen with VerifyApp. Append iterations;
never rewrite the ones above.

## Iteration 0 — from the template

- [x] Records table with title, amount, status, notes, created_at.
      Done when: `AppManage tables` lists every column with its constraint.
- [x] Summary strip leads the page: open count, open amount, done count.
      Done when: creating an open record changes two of the three figures.
- [x] Create and edit through one form with field-level messages.
      Done when: an empty title shows "Give it a name." beside the field.
- [x] Mark done from the row; delete in two steps.
      Done when: Done flips the pill to green; Delete asks before removing.

## Iteration 1 — make it this user's tool

- [ ] Rename `records` and its columns to the real domain.
      Done when: the table name and every label use the user's words.
- [ ] Add the field the user filters by most, and a filter control above the table.
      Done when: the filter narrows the rows and the summary follows it.
- [ ] Decide the status lifecycle with the user and encode it in the CHECK.
      Done when: an unknown status is refused by the database, not the page.
