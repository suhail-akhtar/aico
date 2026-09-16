# Backlog — Stickyboard

## Iteration 1 — a team can share a board of sticky notes and see each other's changes

- [x] Open a board and see its notes as sticky cards.
      Done when: VerifyApp check "open a board" — the seeded board renders its
      notes with title, body, colour and author, and a board with no notes shows
      its empty state.
- [x] Add a sticky note with a title, a body and a colour.
      Done when: VerifyApp check "add a sticky note with a title, a body and a
      colour" and check "the note body survives a reload" — the new card appears
      on the wall and is still there after a reload.
- [x] Edit a note's title, body or colour, and delete it.
      Done when: VerifyApp check "edit a note" and check "delete a note" — the
      card shows the new text in place, and the deleted card is gone after a
      reload.
- [x] Have a teammate's change appear on the wall without a refresh.
      Done when: test/events.test.ts — two subscribers to one board both receive
      the note event, and VerifyApp check "live changes arrive" — the header
      reports the stream connected against a running server.
- [x] Create a board and switch between boards.
      Done when: VerifyApp check "create a board" and check "switch between
      boards" — the new board appears in the sidebar, opens, and is still the
      open board after a reload.

## Later

- Drag-to-arrange notes on the wall (`position` already exists for it).
- Search across boards, and a "recently changed" view.
- Undo for a delete, and an edit history per note.
- Real accounts, so a note can be attributed beyond a self-declared name.
- Publish board creation and renames on a stream of their own, so a teammate's
  new board appears in the sidebar without a reload.
