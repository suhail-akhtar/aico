/**
 * Remembering which workspace a new chat should start in.
 *
 * A brand-new chat never had a project set on it at all until a message was
 * sent, which is its own bug (see `store.ts`'s `connect`) — but even once
 * that's fixed, "wherever the server happens to default to" is not the same
 * as "the workspace I actually work in." This is the other half: whatever
 * project a chat ends up using, whether picked explicitly or landed on by
 * default, becomes what the *next* new chat starts in too.
 *
 * `localStorage`, not `sessionStorage`, for the same reason `session-memory`
 * uses it — the point is surviving a tab close, not being scoped to one.
 *
 * Storage can be unavailable (private browsing, blocked cookies, a locked
 * profile), so every access is guarded exactly like `session-memory`'s own.
 * No format validation is needed the way a session id needs one: an invalid
 * or since-removed path is already handled server-side by `resolveCwd`'s
 * `isKnownProject` check, the same way `store.project` is already trusted
 * without client-side validation today.
 *
 * @module workspace-memory
 */
import type { SessionStore } from './session-memory';

const LAST_PROJECT_KEY = 'aico.project';

function defaultStore(): SessionStore | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** The project a new chat should start in, absent any other signal. */
export function lastWorkspace(store: SessionStore | null = defaultStore()): string | null {
  try {
    return store?.getItem(LAST_PROJECT_KEY) || null;
  } catch {
    return null;
  }
}

/** Record the project a chat is actually using. */
export function rememberWorkspace(path: string, store: SessionStore | null = defaultStore()): void {
  try { store?.setItem(LAST_PROJECT_KEY, path); } catch { /* see above */ }
}

/** Forget the remembered workspace, so the next new chat has no default. */
export function forgetWorkspace(store: SessionStore | null = defaultStore()): void {
  try { store?.removeItem(LAST_PROJECT_KEY); } catch { /* see above */ }
}
