# Backlog — StockCup

One vertical slice per story: data → logic → screen → check. Tick a story only
once its "Done when" was observed.

## Iteration 1 — the café can stock the shelves, sell a drink, and see what to reorder

- [x] I can add an ingredient with what is on the shelf and the level I reorder at, and correct the count when I check it.
      Done when: VerifyApp check "add an ingredient with a threshold" — adding Espresso beans, 900 g, reorder at 500 g lists it at 900 g, and correcting it to 640 g shows 640 g.
- [x] I can build a recipe for a drink out of ingredients and amounts.
      Done when: VerifyApp check "build a drink from ingredients" — saving a Flat white with 18 g Espresso beans and 150 ml Milk shows both lines with their amounts.
- [x] Logging a sale takes the right ingredients off the shelf by itself.
      Done when: VerifyApp check "logging a sale deducts the ingredients" — logging 2 Flat whites drops Espresso beans by 36 g and Milk by 300 ml; test/sales.test.ts asserts the same deduction on an in-memory database.
- [ ] The dashboard names everything that is under its threshold before the next order.
      Done when: VerifyApp check "see what is under its threshold" — a sale that takes Milk under its threshold puts Milk on the dashboard with how much is missing, and a fully stocked café gets a plain "nothing to reorder" line.
- [ ] I can remove a sale I logged by mistake and the stock goes back up.
      Done when: VerifyApp check "remove a wrong sale" — removing a logged sale restores the ingredient quantities and deletes its stock movements; test/sales.test.ts covers the reversal.

## Later (named only, not planned in detail)
- The café's own opening list seeded on first run, so the first visit is not data entry.
- Editing and retiring a recipe; a drink that is off the menu.
- Waste and spillage logging, so shrinkage is visible.
- Named accounts with a "who logged it" trail.
- Reorder email to the supplier from the dashboard.

## Done — shipped
