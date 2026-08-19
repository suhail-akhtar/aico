/**
 * Whether the page should still believe a turn is running.
 *
 * `busy` is normally driven by events: `turn-start` sets it, `turn-end` clears
 * it. That works right up until the event that would clear it never arrives —
 * a submit whose request never settled leaves the client certain a turn is
 * running while the server has no record of one, and every escape route
 * depends on the same missing event. The page sits at "running" forever and
 * Stop cannot help, which is the "stuck until I killed it" the stall detector
 * exists to end.
 *
 * Pressing Stop is the moment to reconcile, and this is the rule it uses. It
 * is a rule rather than a line inside the handler because the interesting part
 * is the unreachable case, and that deserves to be stated once and tested.
 *
 * @module turn-state
 */

/** What the server said about the turn when we asked. */
export type ServerTurn = { running: boolean } | 'unreachable';

/**
 * Should Stop clear the local `busy` flag?
 *
 * The server is the source of truth and is asked, not overruled. The one place
 * that judgement is made without it is when the server cannot be reached: a
 * server we cannot talk to is certainly not mid-turn on our behalf, and of the
 * two ways to be wrong, a page that stops claiming to be busy is recoverable
 * and a page that never stops is not.
 */
export function shouldClearBusy(locallyBusy: boolean, server: ServerTurn): boolean {
  if (!locallyBusy) return false;
  if (server === 'unreachable') return true;
  return !server.running;
}
