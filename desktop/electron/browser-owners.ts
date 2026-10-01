/**
 * Who may drive which browser tab — the rules, kept pure so they are tested.
 *
 * THE FAILURE THAT SHAPED IT. Every agent session reaches the built-in browser
 * through the same `browser_*` tools, and every one of those tools acted on
 * the tab in front. Two chats working on two projects, or a chat and the
 * browser copilot, navigated and clicked on each other's page — and on the
 * page the person was reading. The engine now says which session is calling
 * (MCP `_meta`, src/mcp/registry.ts `hostCallMeta`); this module decides what
 * that caller may touch:
 *
 *   - the COPILOT works on "this page": the person's tab in front, as before;
 *   - any OTHER chat gets tabs of its own. Its first browser_open makes one in
 *     the background (never stealing the front tab or focus); later calls with
 *     no tab named act on its most recent one. A tab it does not own is
 *     refused — unless the person handed that tab to this chat;
 *   - LEASES: one driver per tab at a time. A second session waits in line
 *     (bounded: the MCP call must return) and then hears "busy with <chat>",
 *     instead of interleaving clicks with the first;
 *   - the PERSON always wins: input on a tab an agent is driving pauses it
 *     there (the existing Take over), until they press Let AICO continue.
 *
 * What it deliberately does not do: own the tabs, talk to Electron, or decide
 * any safety question (purchase gate, human checks, vault, injection guard) —
 * those stay per tab in browser.ts, unchanged, whoever drives.
 *
 * @module desktop/electron/browser-owners
 */

export interface Caller {
  /** The engine session (chat) that made the tool call. */
  sessionId: string;
  /** The browser copilot's conversation: it works on the page the person is looking at. */
  copilot: boolean;
  /** The chat's title, for badges and "busy" answers. */
  title: string;
}

export interface TabOwner {
  sessionId: string;
  title: string;
  /** The chat's run ended: the tab stays open (the person may want it) but nobody is driving it. */
  released: boolean;
  since: number;
}

/** What a call wants to do with "a tab". */
export type Intent = 'act' | 'open' | 'openNew';

export type Route =
  /** The person's tab in front (the copilot, or a call that names no session). */
  | { kind: 'front' }
  | { kind: 'tab'; tabId: string }
  /** A new tab: the caller's own, in the background (the copilot's comes to the front, as before). */
  | { kind: 'create' }
  | { kind: 'refuse'; message: string };

export interface World {
  alive(tabId: string): boolean;
  front: string | null;
}

export const NO_TAB_YET = 'You have no browser tab of your own yet. Call browser_open with a URL: it opens in a background tab that belongs to this chat (the user keeps the tab they are looking at). The user\'s tab in front is theirs and the browser copilot\'s; you may use it only if the user hands it to this chat.';

/** The chat titles, for messages. */
const named = (title: string): string => `the chat “${title || 'untitled'}”`;

export class TabOwners {
  private owners = new Map<string, TabOwner>();
  /** Tab → the sessions the person handed it to. */
  private grants = new Map<string, Set<string>>();
  /** Session → the tab it used last. */
  private last = new Map<string, string>();

  ownerOf(tabId: string): TabOwner | undefined { return this.owners.get(tabId); }

  /** A tab this caller made: theirs. */
  claim(tabId: string, caller: Pick<Caller, 'sessionId' | 'title'>, now = Date.now()): void {
    this.owners.set(tabId, { sessionId: caller.sessionId, title: caller.title, released: false, since: now });
    this.last.set(caller.sessionId, tabId);
  }

  /** The person handed this tab to a chat ("use this page"). */
  grant(tabId: string, sessionId: string): void {
    const set = this.grants.get(tabId) ?? new Set<string>();
    set.add(sessionId);
    this.grants.set(tabId, set);
  }

  granted(tabId: string, sessionId: string): boolean { return Boolean(this.grants.get(tabId)?.has(sessionId)); }

  /** May this session drive this tab without asking: its own, or handed to it. */
  mayDrive(tabId: string, sessionId: string): boolean {
    return this.owners.get(tabId)?.sessionId === sessionId || this.granted(tabId, sessionId);
  }

  /** A call used this tab: it is now the session's current one (and its own tab is no longer released). */
  use(tabId: string, sessionId: string): void {
    this.last.set(sessionId, tabId);
    const o = this.owners.get(tabId);
    if (o && o.sessionId === sessionId && o.released) o.released = false;
  }

  /** The tab closed. */
  forget(tabId: string): void {
    this.owners.delete(tabId);
    this.grants.delete(tabId);
    for (const [s, t] of this.last) if (t === tabId) this.last.delete(s);
  }

  /** The chat's run ended: its tabs stay, marked released. Returns the tabs that changed. */
  release(sessionId: string): string[] {
    const changed: string[] = [];
    for (const [id, o] of this.owners) if (o.sessionId === sessionId && !o.released) { o.released = true; changed.push(id); }
    return changed;
  }

  /** A chat was renamed (its title is what the badge and the busy answer show). */
  rename(sessionId: string, title: string): boolean {
    let changed = false;
    for (const o of this.owners.values()) if (o.sessionId === sessionId && title && o.title !== title) { o.title = title; changed = true; }
    return changed;
  }

  /** Sessions that own a tab nobody has released yet. */
  activeSessions(): string[] {
    return [...new Set([...this.owners.values()].filter(o => !o.released).map(o => o.sessionId))];
  }

  /** The session's current tab: the one it used last, else its newest own tab, else one handed to it. */
  current(sessionId: string, world: World): string | null {
    const last = this.last.get(sessionId);
    if (last && world.alive(last) && this.mayDrive(last, sessionId)) return last;
    const own = [...this.owners.entries()].filter(([id, o]) => o.sessionId === sessionId && world.alive(id)).sort((a, b) => b[1].since - a[1].since);
    if (own[0]) return own[0][0];
    for (const [id, set] of this.grants) if (set.has(sessionId) && world.alive(id)) return id;
    return null;
  }

  /** Where this call goes. `caller` null: a call that names no session — the tab in front, as always. */
  route(caller: Caller | null, req: { tabId?: string; intent: Intent }, world: World): Route {
    if (req.tabId !== undefined && !world.alive(req.tabId)) return { kind: 'refuse', message: `There is no tab "${req.tabId}". Call browser_tabs to see the tabs you may use.` };
    if (!caller || caller.copilot) {
      if (req.tabId !== undefined) return { kind: 'tab', tabId: req.tabId };
      return req.intent === 'openNew' ? { kind: 'create' } : { kind: 'front' };
    }
    if (req.tabId !== undefined) {
      if (this.mayDrive(req.tabId, caller.sessionId)) return { kind: 'tab', tabId: req.tabId };
      const o = this.owners.get(req.tabId);
      return {
        kind: 'refuse',
        message: `Tab ${req.tabId} is not yours: it ${o ? `belongs to ${named(o.title)}` : 'is the user\'s'}. Open a tab of your own with browser_open (it opens in the background), or ask the user to hand this tab to this chat (right-click the tab → "Let the open chat use this tab").`,
      };
    }
    if (req.intent === 'openNew') return { kind: 'create' };
    const mine = this.current(caller.sessionId, world);
    if (mine) return { kind: 'tab', tabId: mine };
    return req.intent === 'open' ? { kind: 'create' } : { kind: 'refuse', message: NO_TAB_YET };
  }

  /**
   * What browser_tabs shows this caller: for a chat, its own tabs, the ones
   * handed to it, and the person's front tab (read-only, unless handed over).
   * The copilot (or no caller) sees every tab.
   */
  visible(caller: Caller | null, tabIds: string[], front: string | null): Array<{ id: string; yours: boolean; handedToYou: boolean; userFront: boolean; readOnly: boolean; owner?: string }> {
    return tabIds.flatMap((id) => {
      const o = this.owners.get(id);
      const owner = o ? o.title : undefined;
      if (!caller || caller.copilot) return [{ id, yours: false, handedToYou: false, userFront: id === front, readOnly: false, ...(owner ? { owner } : {}) }];
      const yours = o?.sessionId === caller.sessionId;
      const handedToYou = !yours && this.granted(id, caller.sessionId);
      const userFront = id === front;
      if (!yours && !handedToYou && !userFront) return [];
      return [{ id, yours, handedToYou, userFront, readOnly: !yours && !handedToYou, ...(owner && !yours ? { owner } : {}) }];
    });
  }

  /** May this caller close the tab? Only its own (never the person's, never one merely handed over). */
  mayClose(caller: Caller | null, tabId: string): boolean {
    if (!caller || caller.copilot) return true;
    return this.owners.get(tabId)?.sessionId === caller.sessionId;
  }
}

// ── Leases: one driver per tab ──

export interface LeaseHolder { sessionId: string; title: string }

/** `ended`: its run ended or the person took the tab back — it lapses as soon as the calls in flight finish. */
interface Lease { holder: LeaseHolder; calls: number; lastAt: number; ended?: boolean }

export interface LeaseOptions {
  /** A lease outlives its last call by this long (the model thinks between calls). */
  idleMs: number;
  /** How long a second session waits in line before it is told the tab is busy. */
  waitMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
}

export type Acquired = { ok: true; release: () => void } | { ok: false; busyWith: LeaseHolder };

/**
 * One session drives a tab at a time. A lease is held from a session's first
 * call on the tab until it has been idle for `idleMs` (or its run ends —
 * `releaseSession`): between two of its calls the model is thinking, and
 * another chat clicking in that gap is exactly the interleaving this exists
 * to stop. Waiters queue first come, first served.
 */
export class TabLeases {
  private leases = new Map<string, Lease>();
  private queues = new Map<string, string[]>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: LeaseOptions) {
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise(r => setTimeout(r, ms)));
  }

  private live(l: Lease | undefined): l is Lease {
    return Boolean(l && (l.calls > 0 || (!l.ended && this.now() - l.lastAt < this.opts.idleMs)));
  }

  /** Who holds the tab now, if anyone. */
  holder(tabId: string): LeaseHolder | undefined {
    const l = this.leases.get(tabId);
    return this.live(l) ? l.holder : undefined;
  }

  /** Take (or keep) the tab for one call. Waits up to `waitMs` behind another session. */
  async acquire(tabId: string, who: LeaseHolder): Promise<Acquired> {
    const deadline = this.now() + this.opts.waitMs;
    const queue = (): string[] => { const q = this.queues.get(tabId) ?? []; this.queues.set(tabId, q); return q; };
    const leave = (): void => { const q = queue(); const i = q.indexOf(who.sessionId); if (i >= 0) q.splice(i, 1); };
    for (;;) {
      const l = this.leases.get(tabId);
      const mine = this.live(l) && l.holder.sessionId === who.sessionId;
      const q = queue();
      const free = !this.live(l) && (q.length === 0 || q[0] === who.sessionId);
      if (mine || free) {
        leave();
        const lease: Lease = mine ? l! : { holder: who, calls: 0, lastAt: this.now() };
        lease.calls++;
        lease.holder = { ...lease.holder, title: who.title || lease.holder.title };
        this.leases.set(tabId, lease);
        let done = false;
        return { ok: true, release: () => { if (done) return; done = true; lease.calls = Math.max(0, lease.calls - 1); lease.lastAt = this.now(); } };
      }
      if (!q.includes(who.sessionId)) q.push(who.sessionId);
      if (this.now() >= deadline) {
        leave();
        return { ok: false, busyWith: (this.live(l) ? l.holder : undefined) ?? { sessionId: q[0] ?? '', title: '' } };
      }
      await this.sleep(this.opts.pollMs ?? 150);
    }
  }

  /** The session's run ended: its leases go as soon as its calls in flight finish. */
  releaseSession(sessionId: string): void {
    for (const [id, l] of this.leases) {
      if (l.holder.sessionId !== sessionId) continue;
      if (l.calls === 0) this.leases.delete(id); else l.ended = true;
    }
  }

  /** The person took the tab back: whoever held it lets go (their next call is refused by the pause anyway). */
  drop(tabId: string): void {
    const l = this.leases.get(tabId);
    if (l) l.ended = true;
    if (l && l.calls === 0) this.leases.delete(tabId);
  }

  forget(tabId: string): void {
    this.leases.delete(tabId);
    this.queues.delete(tabId);
  }
}

export const busyMessage = (tabId: string, h: LeaseHolder): string =>
  `Tab ${tabId} is busy: ${named(h.title)} is driving it, and it did not come free in time. Nothing was done. Wait and try again later, or open a tab of your own with browser_open.`;

/**
 * Was this input on the page the person's, while an agent was driving the
 * tab? Then the agent pauses there. The agent's own trusted input arrives as
 * input events too, so input just after an agent keystroke or click is its own.
 */
export function personTookOver(o: { driving: boolean; held: boolean; agentInputAt: number; now: number }): boolean {
  return o.driving && o.held && o.now - o.agentInputAt > 600;
}

/** A stable colour (hue, 0–359) for a chat's tabs, so its tabs read as a group in the strip. */
export function ownerHue(sessionId: string): number {
  let h = 0;
  for (let i = 0; i < sessionId.length; i++) h = (h * 31 + sessionId.charCodeAt(i)) >>> 0;
  // Twelve hues 30° apart, skipping the reds a warning would use.
  return 30 + (h % 11) * 30;
}
