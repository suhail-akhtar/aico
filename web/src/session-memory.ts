/**
 * Remembering which session you were in.
 *
 * The premise of a server-owned run is that closing the tab costs nothing. That
 * was false in one specific, very visible way: reloading the page minted a
 * fresh session id and connected to *that*, so a refresh showed an empty
 * conversation. The transcript was on disk the whole time — it just was not the
 * session being displayed, which is indistinguishable from having lost it.
 *
 * `localStorage`, not `sessionStorage`: forgetting on tab close is exactly the
 * case this exists to handle.
 *
 * Storage can be unavailable — private browsing, blocked cookies, a locked-down
 * profile — so every access is guarded. A fresh session is a worse experience,
 * not a broken one, and throwing here would take down the whole app.
 *
 * @module session-memory
 */

const LAST_SESSION_KEY = 'aico.session';

/** The subset of the Storage API this module uses, so tests can supply one. */
export interface SessionStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStore(): SessionStore | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** A new, unique session id. */
export function freshSessionId(now = Date.now(), random = Math.random): string {
  return `web-${now.toString(36)}-${random().toString(36).slice(2, 8)}`;
}

/**
 * The session to open on load: the one you were last in, or a new one.
 *
 * A stored value is validated rather than trusted — anything can end up in
 * `localStorage`, and a malformed id would be sent to the server on every
 * request until someone cleared it by hand.
 */
export function initialSessionId(
  store: SessionStore | null = defaultStore(),
  makeId: () => string = () => freshSessionId(),
): string {
  try {
    const remembered = store?.getItem(LAST_SESSION_KEY);
    if (remembered && isValidSessionId(remembered)) return remembered;
  } catch {
    // Reading can throw even when the object exists (Safari private mode).
  }
  return makeId();
}

/** Record the session now being shown. */
export function rememberSession(
  sessionId: string,
  store: SessionStore | null = defaultStore(),
): void {
  if (!isValidSessionId(sessionId)) return;
  try { store?.setItem(LAST_SESSION_KEY, sessionId); } catch { /* see above */ }
}

/** Forget the remembered session, so the next load starts fresh. */
export function forgetSession(store: SessionStore | null = defaultStore()): void {
  try { store?.removeItem(LAST_SESSION_KEY); } catch { /* see above */ }
}

/**
 * Whether a string is usable as a session id.
 *
 * Session ids become filenames, so the same characters the log writer would
 * reject are rejected here — before one reaches a path.
 */
export function isValidSessionId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(value);
}
