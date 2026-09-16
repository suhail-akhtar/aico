# Backlog — VenueSlot

## Iteration 1 — Book the hall for a month without a double-booking

- [x] Staff can add a booking and see it on the month calendar with its setup
      and teardown blocked out, and a booking that would overlap an existing
      block is refused.
      Done when: VerifyApp check "add a booking to the month" — a Wedding on
      12 Sep 2026, 14:00–22:00 appears on 12 September showing its
      11:00–00:00 block; and check "a clashing booking is refused" — a second
      booking at 23:00 the same day is rejected and does not appear.
- [x] A refused booking says which booking it collides with, with that
      booking's time, and the colliding day is marked on the calendar.
      Done when: VerifyApp check "clash names the other event" — the refusal
      reads with the existing event's name and time.
- [x] Staff can cancel a booking from the calendar, and the freed slot can
      then be booked.
      Done when: VerifyApp check "cancel frees the slot" — cancel removes the
      booking from the grid and a booking into that window is then accepted.
- [x] Staff can change one booking's setup and teardown without changing the
      event type's defaults.
      Done when: VerifyApp check "override the setup time" — a 30-minute setup
      moves the block's start on the grid and the overlap rule uses the new
      window; test/bookings.test.ts "override shortens the block" passes.
- [x] Staff can add an event type with its own setup and teardown times.
      Done when: VerifyApp check "add an event type" — a new type with a
      45-minute setup appears in the booking form's type list with its times.

## Later

- A second bookable space, and moving a booking between spaces.
- Sign-in and roles (who may cancel another person's booking).
- iCal feed of the month, and email confirmation to the customer.
- Drag a booking to another day; suggest the nearest free window on a clash.
- Deposits and invoices against a booking.
