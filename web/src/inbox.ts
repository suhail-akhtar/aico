/**
 * "Waiting for you": what the approve-later inbox shows, as pure functions
 * shared by the web client and the desktop (design §7.7, §8.3).
 *
 * An unattended (L4) run parks a call that needs a person instead of running
 * it. The card must let someone decide without opening the run: the exact
 * call, the preview (the diff), the effect class and why it needed a person,
 * where it came from and how long it waits. Status is always a word, never
 * only a colour (§7.8). Kept free of React and the API client so
 * `test:web:unit` can check it.
 *
 * @module web/inbox
 */

/** One parked call, as `inbox/list` returns it (engine: autonomy/inbox `PendingAction`). */
export interface ParkedAction {
  id: string;
  status: 'pending' | 'approved' | 'executed' | 'failed' | 'diverged' | 'denied' | 'expired';
  createdAt: number;
  expiresAt: number;
  origin: 'chat' | 'cron' | 'background' | 'remote';
  label?: string;
  sessionId?: string;
  cwd: string;
  tool: string;
  effect: string;
  why: string;
  call: string;
  preview?: string;
  decidedAt?: number;
  decidedVia?: string;
  outcome?: string;
  newPreview?: string;
}

const STATUS: Record<ParkedAction['status'], string> = {
  pending: 'Waiting for you',
  approved: 'Running',
  executed: 'Approved — ran',
  failed: 'Approved — failed',
  diverged: 'Refused — changed since parked',
  denied: 'Denied',
  expired: 'Expired',
};

export function statusLabel(status: ParkedAction['status']): string {
  return STATUS[status] ?? status;
}

const ORIGIN: Record<ParkedAction['origin'], string> = {
  chat: 'Chat', cron: 'Schedule', background: 'Background job', remote: 'Remote (MCP)',
};

/** "Schedule · nightly deploy" */
export function originLabel(a: Pick<ParkedAction, 'origin' | 'label'>): string {
  const kind = ORIGIN[a.origin] ?? a.origin;
  return a.label ? `${kind} · ${a.label}` : kind;
}

/** How long until it expires, in words: "expires in 3 h", "expires in 12 min", "expired". */
export function expiresIn(expiresAt: number, now: number = Date.now()): string {
  const ms = expiresAt - now;
  if (ms <= 0) return 'expired';
  const min = Math.ceil(ms / 60_000);
  if (min < 60) return `expires in ${min} min`;
  const h = Math.round(min / 60);
  return h < 48 ? `expires in ${h} h` : `expires in ${Math.round(h / 24)} days`;
}

/** The preview's first line, for the collapsed card ("Preview (k8s_helm_diff): 3 lines"). */
export function previewSummary(preview: string | undefined): string | undefined {
  if (!preview) return undefined;
  const [head = '', ...rest] = preview.split('\n');
  const lines = rest.filter(l => l.trim()).length;
  return lines ? `${head.replace(/:$/, '')} — ${lines} line${lines === 1 ? '' : 's'}` : head;
}

/** Pending first (oldest first: the one waiting longest), then decisions, newest first. */
export function sortActions(list: readonly ParkedAction[]): ParkedAction[] {
  const pending = list.filter(a => a.status === 'pending').sort((a, b) => a.createdAt - b.createdAt);
  const rest = list.filter(a => a.status !== 'pending').sort((a, b) => (b.decidedAt ?? b.createdAt) - (a.decidedAt ?? a.createdAt));
  return [...pending, ...rest];
}

/** Ids pending now that were not pending before — what deserves a notification. */
export function newlyPending(before: readonly ParkedAction[], now: readonly ParkedAction[]): ParkedAction[] {
  const seen = new Set(before.filter(a => a.status === 'pending').map(a => a.id));
  return now.filter(a => a.status === 'pending' && !seen.has(a.id));
}

/** The badge text: nothing when nothing waits, "9+" past nine. */
export function badgeText(pending: number): string {
  return pending <= 0 ? '' : pending > 9 ? '9+' : String(pending);
}
