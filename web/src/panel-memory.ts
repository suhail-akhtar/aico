/**
 * Panels you have closed, remembered across reloads.
 *
 * Closing a panel was previously a fact about the current page rather than
 * about the conversation: dismiss the plan, reload, and it was back. That is
 * defensible for a panel you closed by accident and indefensible for one you
 * closed because the plan is over — the reader has to dismiss the same dead
 * plan on every visit, and eventually stops reading the panel at all.
 *
 * Kept per session, because a dismissal says nothing about the next
 * conversation, and keyed by content identity inside that, because a *new*
 * plan in the same session should still appear. Both halves matter: drop the
 * session key and one closed panel silences every session; drop the identity
 * and the panel never returns at all.
 *
 * `localStorage`, and guarded everywhere, for the reasons in
 * {@link module:session-memory} — storage can be absent or throw, and a
 * forgotten dismissal is a smaller problem than a blank screen.
 *
 * Old sessions are evicted on write. Without that this grows by a few bytes
 * per session forever, which is slow enough to never be noticed and permanent
 * enough to never be cleaned up.
 *
 * @module panel-memory
 */

import type { SessionStore } from './session-memory';

const KEY = 'aico.dismissed';

/** How many sessions' dismissals to keep. Beyond this, the oldest are dropped. */
const KEEP_SESSIONS = 40;

/** `{ [sessionId]: { [panel]: identity } }`, most recently written last. */
type Remembered = Record<string, Record<string, string>>;

function defaultStore(): SessionStore | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * Everything remembered, or nothing.
 *
 * Anything can end up in `localStorage` — an older version of this app, a
 * different app on the same origin, a person with the console open. The shape
 * is checked rather than asserted, and a value that fails is discarded whole:
 * partially trusting malformed state is how a bad key survives for months.
 */
function read(store: SessionStore | null): Remembered {
  let raw: string | null = null;
  try { raw = store?.getItem(KEY) ?? null; } catch { return {}; }
  if (!raw) return {};

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

    const clean: Remembered = {};
    for (const [session, panels] of Object.entries(parsed as Record<string, unknown>)) {
      if (!panels || typeof panels !== 'object' || Array.isArray(panels)) continue;
      const entries = Object.entries(panels as Record<string, unknown>)
        .filter((pair): pair is [string, string] => typeof pair[1] === 'string');
      if (entries.length > 0) clean[session] = Object.fromEntries(entries);
    }
    return clean;
  } catch {
    return {};
  }
}

/** Panels dismissed in this session, by panel name. */
export function loadDismissals(
  sessionId: string,
  store: SessionStore | null = defaultStore(),
): Record<string, string> {
  return read(store)[sessionId] ?? {};
}

/**
 * Record this session's dismissals, replacing whatever was stored for it.
 *
 * Takes the whole map rather than one panel so it matches how the store holds
 * it, and so clearing is expressible: an empty map removes the session.
 */
export function saveDismissals(
  sessionId: string,
  dismissed: Record<string, string>,
  store: SessionStore | null = defaultStore(),
): void {
  if (!store) return;

  const all = read(store);
  // Deleted first so re-inserting moves the session to the end, which is what
  // makes the eviction below drop the least recently *used* rather than the
  // oldest ever created.
  delete all[sessionId];
  if (Object.keys(dismissed).length > 0) all[sessionId] = dismissed;

  const sessions = Object.keys(all);
  for (const stale of sessions.slice(0, Math.max(0, sessions.length - KEEP_SESSIONS))) {
    delete all[stale];
  }

  try { store.setItem(KEY, JSON.stringify(all)); } catch { /* see the module note */ }
}
