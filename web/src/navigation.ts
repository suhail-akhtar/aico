/**
 * Where the portal can be, in two axes.
 *
 * A *destination* is a place in the product: the sessions (the list on the left
 * and whichever conversation is open), the Apps you have built, and System —
 * what is running on the server. A *tab* is one of three readings of the open
 * session: what was said, what it did to the tree, and what happened in what
 * order.
 *
 * They used to be one flat union, which had two consequences. The tabs were
 * drawn on every screen, so clicking "Changes" while looking at System silently
 * left System for a session view — a destination change from a control that
 * says nothing about destinations. And there was no way to link to a
 * destination: `?settings=` could open the settings sheet from the VS Code
 * panel, but nothing could open the Apps screen. `parseView` is that link.
 *
 * Pure, and in its own module so the header title and the tab-visibility rule
 * can be tested without a DOM.
 *
 * @module navigation
 */

export type Destination = 'sessions' | 'apps' | 'system';
export type SessionTab = 'chat' | 'changes' | 'trajectory';

export interface Route {
  destination: Destination;
  /** Which reading of the open session is shown. Kept while visiting Apps or System, so coming back lands where you were. */
  tab: SessionTab;
}

export const DEFAULT_ROUTE: Route = { destination: 'sessions', tab: 'chat' };

const DESTINATIONS: readonly Destination[] = ['sessions', 'apps', 'system'];
const TABS: readonly SessionTab[] = ['chat', 'changes', 'trajectory'];

export function isDestination(value: unknown): value is Destination {
  return typeof value === 'string' && (DESTINATIONS as readonly string[]).includes(value);
}

export function isSessionTab(value: unknown): value is SessionTab {
  return typeof value === 'string' && (TABS as readonly string[]).includes(value);
}

/** The session tabs and the session menu only mean something on the sessions destination. */
export function showsSessionTabs(route: Route): boolean {
  return route.destination === 'sessions';
}

/**
 * What the header says.
 *
 * On a destination the header names the place. On the sessions destination it
 * names the conversation, which for a brand-new one is "New session" until the
 * first exchange gives it a title.
 */
export function headerTitle(route: Route, sessionTitle: string | undefined): string {
  if (route.destination === 'apps') return 'Apps';
  if (route.destination === 'system') return 'System';
  return sessionTitle?.trim() || 'New session';
}

/**
 * The destination a link asked for, if it asked for a valid one.
 *
 * `?view=apps` opens the Apps screen; `?view=system` opens System. Anything
 * else — including the old `miniapps` value, which no surface ever linked to —
 * is ignored rather than guessed at, so a typo lands on the sessions like a
 * plain visit would. Same one-shot contract as `?settings=`: the caller strips
 * the parameter once read, because a deep link is an entry point, not a mode.
 */
export function parseView(search: string): Destination | null {
  let value: string | null = null;
  try {
    value = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search).get('view');
  } catch {
    return null;
  }
  return isDestination(value) && value !== 'sessions' ? value : null;
}

/** Move to a destination, keeping the session tab for the way back. */
export function goTo(route: Route, destination: Destination): Route {
  return route.destination === destination ? route : { ...route, destination };
}

/** Toggle a destination from the nav: clicking the one you are on returns to the sessions. */
export function toggleDestination(route: Route, destination: Destination): Route {
  return route.destination === destination
    ? { ...route, destination: 'sessions' }
    : { ...route, destination };
}

/** Switch tabs, which always means the sessions destination. */
export function withTab(route: Route, tab: SessionTab): Route {
  return { destination: 'sessions', tab };
}
