# Backlog — __APP_TITLE__

Stories are vertical slices. Tick a box only when its "Done when" is met and was
checked in a browser. Add iterations at the bottom; never rewrite history above.

## Iteration 0 — from the template

- [x] Page renders with header, hero, features, pricing, FAQ, contact, footer.
      Done when: VerifyApp sees every `section[id]` and the `h1`.
- [x] Mobile menu opens and closes without JavaScript errors.
      Done when: VerifyApp at 390px width toggles `nav` via the menu button.
- [x] FAQ answers expand one at a time.
      Done when: clicking a question reveals its answer; the others close.
- [x] Contact form refuses an invalid email before submitting.
      Done when: `not-an-email` shows the inline error and nothing is posted.

## Iteration 1 — the real content

- [ ] Replace placeholder copy with the product's actual claims.
      Done when: no text containing "placeholder" remains (Grep).
- [ ] Wire the contact form to a real endpoint or form service.
      Done when: a submission is received where the user said it should go.
- [ ] Add the product's own images under `public/img/` with alt text.
      Done when: every `img` has a non-empty `alt` and loads from `/img/`.
