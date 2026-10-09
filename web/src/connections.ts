/**
 * Connections logic that has no DOM: what a connection's status says, which
 * capability chips to show, how a probe's scopes read against what was asked
 * for, whether the add form may be submitted, what a project mapping sends,
 * and how a pull request and the board's sync state are put into words.
 *
 * WHY separate and pure: this is the part a unit test can pin
 * (web/test-connections.mjs) and the part that must read the same in the web
 * portal, the desktop and the VS Code panel. The engine stays the authority
 * for everything here (it re-validates the URL, refuses an out-of-policy
 * provider, and checks the confirm flag for pull request mode); this module
 * only keeps the page from offering what would be refused, and says why in
 * plain words.
 *
 * Two rules from ADR 0039 shape the code:
 *  - A feature without its chip is not shown. Chips come from the probed
 *    `Capabilities`, never from the provider's name, so a limited server
 *    (no pipelines, no Projects) reads as limited instead of broken.
 *  - A secret never passes through here. There is no token field in any form
 *    model in this file: the token lives in an uncontrolled input in the
 *    component and goes straight to the credential route.
 *
 * What it does not do: fetch, render, or decide policy. `ConnectionsPolicyView`
 * is read, never enforced; the engine enforces it again at the route.
 *
 * @module web/connections
 */

import {
  DEFAULT_STATE_MAP, PROVIDERS,
  type BoardConnection, type Capabilities, type Connection, type ConnectionsPolicyView, type LandingMode, type ProbeResult,
  type ProjectMapping, type ProviderId, type ProviderInfo, type PullState, type RemoteCheck, type RemoteLink, type RepoDetection,
  type ScopeAdvice, type SyncStatus, type WorkItemSource,
} from '../../shared/connections/types';
import { ago, toMs } from './delivery-model';

export type ChipTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

export interface Chip {
  id: string;
  label: string;
  tone: ChipTone;
  title?: string;
  /** Only worth a line in the drawer; a card leaves it out. */
  quiet?: boolean;
}

// ── providers ────────────────────────────────────────────────────────────

export function providerInfo(id: ProviderId, providers: readonly ProviderInfo[] = PROVIDERS): ProviderInfo | undefined {
  return providers.find(p => p.id === id);
}

/** "GitHub", "Azure DevOps"; an unknown id (a custom connector) is shown as written. */
export function providerLabel(id: ProviderId | string, providers: readonly ProviderInfo[] = PROVIDERS): string {
  return providers.find(p => p.id === id)?.label ?? (id === 'custom' ? 'Custom connector' : String(id));
}

/**
 * The words on the "this is a server you run" switch, for the providers that have both a cloud
 * product and a self-hosted one behind one tile. Absent means the tile has no such switch.
 */
export function serverSwitchLabel(id: ProviderId): string | null {
  if (id === 'github') return 'GitHub Enterprise Server';
  if (id === 'gitlab') return 'Self-managed GitLab';
  return null;
}

export interface ProviderTile {
  id: ProviderId | 'other';
  label: string;
  enabled: boolean;
  /** Why it is off: the provider's own `note`, or the policy. */
  note?: string;
}

/**
 * The tiles of step one: every provider the engine lists, supported ones first in the engine's
 * order, then the rest disabled with their note, then "Other". A provider the policy forbids is
 * shown disabled with the policy's reason rather than hidden, so nobody wonders where it went.
 */
export function providerTiles(providers: readonly ProviderInfo[], policy?: ConnectionsPolicyView): ProviderTile[] {
  const tiles: ProviderTile[] = providers
    .filter(p => p.id !== 'custom')
    .map(p => {
      const allowed = providerAllowed(policy, p.id);
      const enabled = p.supported && allowed;
      const note = !p.supported ? p.note ?? 'Not available yet.' : !allowed ? 'Not allowed by your organization.' : undefined;
      return { id: p.id, label: p.label, enabled, ...(note ? { note } : {}) };
    });
  tiles.sort((a, b) => Number(b.enabled) - Number(a.enabled));
  tiles.push({ id: 'other', label: 'Other', enabled: false, note: 'Ask AICO to build a connector for it later.' });
  return tiles;
}

// ── policy ───────────────────────────────────────────────────────────────

/** Does the managed policy allow this provider? An absent policy allows everything. */
export function providerAllowed(policy: ConnectionsPolicyView | undefined, id: ProviderId): boolean {
  if (!policy || policy.mode === 'any') return true;
  if (policy.mode === 'forbid') return false;
  return !policy.providers || policy.providers.includes(id);
}

/** Does the policy allow this host? `*.example.com` matches any subdomain of it. */
export function hostAllowed(policy: ConnectionsPolicyView | undefined, host: string): boolean {
  if (!policy || policy.mode === 'any') return true;
  if (policy.mode === 'forbid') return false;
  if (!policy.hosts) return true;
  const h = host.toLowerCase();
  return policy.hosts.some(p => {
    const pat = p.toLowerCase();
    return pat.startsWith('*.') ? h.endsWith(pat.slice(1)) : h === pat;
  });
}

export interface PolicyView {
  /** Nothing may be added. */
  forbidden: boolean;
  /** Pull request landing may be chosen. */
  prAllowed: boolean;
  /** The one short sentence for the banner; null when nothing restricts connections. */
  banner: string | null;
}

export function policyView(policy: ConnectionsPolicyView | undefined): PolicyView {
  const forbidden = policy?.mode === 'forbid';
  const prAllowed = !forbidden && policy?.maxLanding !== 'local';
  const restricted = Boolean(policy && (policy.mode !== 'any' || policy.maxLanding === 'local'));
  if (!policy || !restricted) return { forbidden: false, prAllowed: true, banner: null };
  const fallback = forbidden ? 'Your organization does not allow connections.'
    : policy.mode === 'allow-list' ? 'Your organization allows connections to approved providers and hosts only.'
    : 'Your organization limits pull request landing to local.';
  return { forbidden, prAllowed, banner: policy.message?.trim() || fallback };
}

// ── status of a connection ───────────────────────────────────────────────

export interface StatusChip {
  label: 'Connected' | 'Needs attention' | 'Off';
  tone: 'success' | 'warning' | 'neutral';
  /** One sentence for why it is not plainly connected; empty when nothing needs saying. */
  reason: string;
  /** What this connection cannot do, as short phrases ("no pipelines"). */
  limits: string[];
}

/** What the probe found missing from a connection, as short phrases. */
export function limitsOf(caps: Capabilities): string[] {
  const out: string[] = [];
  if (!caps.checks.read) out.push('no pipelines');
  if (!caps.pulls.create) out.push('no pull requests');
  if (!caps.items.query) out.push('no work items');
  return out;
}

function inFuture(at: string | undefined, now: number): number | null {
  const ms = toMs(at);
  return ms > now ? ms - now : null;
}

/** "in 5 min", "in 2 h", "shortly". */
export function untilWords(ms: number): string {
  const min = Math.ceil(ms / 60_000);
  if (min <= 1) return 'shortly';
  if (min < 60) return `in ${min} min`;
  return `in ${Math.round(min / 60)} h`;
}

/**
 * The chip and the sentence under it. The engine's `stateDetail` is preferred when it sent one (it
 * knows about policy and network failures this page cannot see); the fallbacks cover a connection
 * that has no token yet, a rate limit and a token missing a required scope.
 */
export function connectionStatus(c: Connection, now: number = Date.now()): StatusChip {
  const limits = c.probe ? limitsOf(c.probe.capabilities) : [];
  if (c.disabled || c.state === 'off') {
    return { label: 'Off', tone: 'neutral', reason: c.stateDetail || 'Turned off. Nothing is imported, pushed or checked.', limits };
  }
  const wait = inFuture(c.rateLimited?.until, now);
  const missing = c.probe?.scopes.missing ?? [];
  if (!c.hasCredential) {
    return { label: 'Needs attention', tone: 'warning', reason: c.stateDetail || 'Add a token to finish setting this up.', limits };
  }
  if (c.state === 'needs-attention') {
    return { label: 'Needs attention', tone: 'warning', reason: c.stateDetail || (missing.length ? `The token is missing: ${missing.join(', ')}.` : 'Sign in again: paste a new token.'), limits };
  }
  if (wait !== null) {
    return { label: 'Needs attention', tone: 'warning', reason: `Rate-limited by the remote. It resumes ${untilWords(wait)}.`, limits };
  }
  return { label: 'Connected', tone: 'success', reason: c.stateDetail || (limits.length ? `Limited: ${limits.join(', ')}.` : ''), limits };
}

// ── capability chips ─────────────────────────────────────────────────────

/** One chip per capability the probe found. A capability that is absent has no chip at all. */
export function capabilityChips(caps: Capabilities): Chip[] {
  const out: Chip[] = [];
  const add = (id: string, label: string, title: string): void => { out.push({ id, label, tone: 'neutral', title }); };
  if (caps.repos) add('repos', 'Repositories', 'Can read repositories and their default branch.');
  if (caps.pulls.create) add('pulls', 'Pull requests', 'Can open and update pull requests.');
  if (caps.pulls.draft) add('draft', 'Draft pull requests', 'Can open pull requests as drafts.');
  if (caps.pulls.comment) add('pr-comments', 'PR comments', 'Can post the evidence report as a comment.');
  if (caps.pulls.merge) add('merge', 'Merge', 'Can merge a pull request when the remote says it is ready.');
  if (caps.items.query) add('items', 'Work items', 'Can import issues or work items as backlog tasks.');
  if (caps.items.transition) add('transition', 'Status updates', 'Can move a work item to the state that matches the task.');
  if (caps.items.comment) add('item-comments', 'Work item comments', 'Can add a progress note to a work item.');
  if (caps.items.create) add('item-create', 'Create items', 'Can create work items from tasks.');
  if (caps.items.estimate !== 'none') add('estimates', caps.items.estimate === 'label' ? 'Estimates (labels)' : 'Estimates', 'Can read story points.');
  if (caps.iterations !== 'none') add('iterations', caps.iterations === 'native' ? 'Iterations' : 'Milestones', 'Can read sprints from the platform.');
  if (caps.checks.read) add('checks', 'Checks', 'Can read the remote\'s check runs and statuses.');
  if (caps.checks.rerun) add('rerun', 'Re-run checks', 'Can re-run a failed check.');
  if (caps.protection.read) add('protection', 'Branch protection', 'Can read the required reviews and checks of a protected branch.');
  return out;
}

// ── scopes: found, needed, missing, extra ────────────────────────────────

export interface ScopeRow {
  scope: string;
  why: string;
  required: boolean;
  status: 'ok' | 'missing';
  /** `reported`: the provider listed the token's scopes. `probed`: it does not, so a real call decided. */
  basis: 'reported' | 'probed';
}

export interface ScopeView {
  rows: ScopeRow[];
  found: string[];
  missing: ScopeRow[];
  extra: string[];
  reported: boolean;
  /** Nothing required is missing. */
  ok: boolean;
  /** Plain advice, least privilege first. */
  advice: string[];
}

/** Does the probe show the feature a scope unlocks working? Used when the provider does not list scopes. */
export function featureWorks(caps: Capabilities, feature: ScopeAdvice['feature']): boolean {
  switch (feature) {
    case 'repos': return caps.repos;
    case 'pulls': return caps.pulls.create;
    case 'items': return caps.items.query;
    case 'checks': return caps.checks.read;
    case 'iterations': return caps.iterations !== 'none';
    case 'protection': return caps.protection.read;
  }
}

const list = (xs: readonly string[]): string => xs.join(', ');

export function scopeView(p: ProbeResult): ScopeView {
  const reported = p.scopes.reported;
  const named = new Set(p.scopes.missing);
  const rows: ScopeRow[] = p.scopes.needed.map(n => ({
    scope: n.scope, why: n.why, required: n.required,
    status: (reported ? named.has(n.scope) : !featureWorks(p.capabilities, n.feature)) ? 'missing' : 'ok',
    basis: reported ? 'reported' : 'probed',
  }));
  const missing = rows.filter(r => r.status === 'missing');
  const requiredMissing = missing.filter(r => r.required);
  const optionalMissing = missing.filter(r => !r.required);
  const advice: string[] = [];
  if (requiredMissing.length) advice.push(`Add ${list(requiredMissing.map(r => r.scope))} to the token, then test again.`);
  if (optionalMissing.length) advice.push(`Optional: ${optionalMissing.map(r => `${r.scope} (${r.why.replace(/[.\s]+$/, '').toLowerCase()})`).join('; ')}.`);
  if (p.scopes.extra.length) {
    advice.push(`This token can do more than AICO needs (${list(p.scopes.extra)}). Create a narrower token with only the permissions listed, paste it here, and revoke this one.`);
  }
  if (!reported) advice.push('This provider does not list a token\'s permissions, so what it can do was checked with real requests.');
  return { rows, found: p.scopes.found, missing, extra: p.scopes.extra, reported, ok: requiredMissing.length === 0, advice };
}

export interface ProbeVerdict { usable: boolean; tone: 'success' | 'warning'; headline: string }

export function probeVerdict(p: ProbeResult): ProbeVerdict {
  const v = scopeView(p);
  if (!v.ok) {
    const names = v.missing.filter(r => r.required).map(r => r.scope);
    return { usable: false, tone: 'warning', headline: `Signed in as ${p.user}, but the token is missing ${list(names)}.` };
  }
  const limits = limitsOf(p.capabilities);
  return {
    usable: true, tone: limits.length || p.scopes.extra.length ? 'warning' : 'success',
    headline: `Signed in as ${p.user}${p.version ? ` on ${p.version}` : ''}.${limits.length ? ` Limited: ${list(limits)}.` : ''}`,
  };
}

// ── "Connect GitHub for this repo?" ──────────────────────────────────────

export interface DetectHint {
  /** The one line. */
  text: string;
  /** The repo it found, "owner/name", when it read one. */
  detail?: string;
  /** `connect`: open the add flow; `map`: an existing connection can serve this project. */
  action: 'connect' | 'map';
  provider?: ProviderId;
  connection?: string;
}

/**
 * The single line the Delivery board shows when a project's origin matches a known host. Never a
 * prompt: null when the project is already mapped, nothing matched, or the matching provider has no
 * adapter yet (offering a connection that cannot be made would be noise).
 */
export function detectHint(det: RepoDetection | null | undefined, connections: readonly Connection[], mapped: boolean, providers: readonly ProviderInfo[] = PROVIDERS): DetectHint | null {
  if (mapped || !det) return null;
  const detail = det.repo ? `${det.repo.owner}/${det.repo.name}` : undefined;
  const existing = det.connection ? connections.find(c => c.id === det.connection && !c.disabled) : undefined;
  if (existing) return { text: `Use ${existing.label} for this repo?`, ...(detail ? { detail } : {}), action: 'map', connection: existing.id, provider: existing.provider };
  const info = det.provider ? providerInfo(det.provider, providers) : undefined;
  if (!info || !info.supported) return null;
  return { text: `Connect ${info.label} for this repo?`, ...(detail ? { detail } : {}), action: 'connect', provider: info.id };
}

// ── the add-connection form ──────────────────────────────────────────────

export interface ConnectionForm {
  provider: ProviderId;
  label: string;
  /** The person switched to a server they run (Enterprise Server, self-managed). */
  serverUrl: boolean;
  baseUrl: string;
  insecureHttp: boolean;
  caBundle: string;
}

export interface CreateBody {
  provider: ProviderId;
  label?: string;
  baseUrl?: string;
  insecureHttp?: boolean;
  caBundle?: string;
}

export type FormField = 'label' | 'baseUrl' | 'insecureHttp' | 'caBundle';

export interface FormCheck {
  ok: boolean;
  errors: Partial<Record<FormField, string>>;
  /** What to post; present only when `ok`. */
  body?: CreateBody;
  /** The URL is plain http to a private address and the box is not ticked yet. */
  needsHttpOptIn: boolean;
}

/** Private or loopback: where plain http may be allowed with an explicit opt-in. Link-local and metadata addresses are never private here (the engine refuses them). */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return false;
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1') return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if ([a, b, Number(v4[3]), Number(v4[4])].some(n => n > 255)) return false;
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (h.includes(':')) return /^f[cd][0-9a-f]{2}:/.test(h);
  return !h.includes('.') || /\.(local|lan|internal|intranet|corp|home\.arpa)$/.test(h);
}

export type UrlCheck = { ok: true; url: string; plainHttp: boolean; host: string } | { ok: false; error: string };

/** A server address: https, or http to a private address the person opted into; no user name or password; no query. */
export function checkBaseUrl(raw: string, insecureHttp: boolean): UrlCheck {
  const text = raw.trim();
  if (!text) return { ok: false, error: 'Enter the server address, for example https://git.example.com.' };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return { ok: false, error: 'Start the address with https://.' };
  let u: URL;
  try { u = new URL(text); } catch { return { ok: false, error: 'That is not a valid address.' }; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, error: 'Only https:// addresses can be used.' };
  if (u.username || u.password) return { ok: false, error: 'Remove the user name and password from the address. The token is entered on its own.' };
  if (!u.hostname) return { ok: false, error: 'That address has no host name.' };
  if (u.search || u.hash) return { ok: false, error: 'Use the plain address, without ? or # parts.' };
  const plainHttp = u.protocol === 'http:';
  if (plainHttp && !isPrivateHost(u.hostname)) return { ok: false, error: 'Plain http is only allowed for a private address on your own network. Use https:// for this one.' };
  const url = `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  if (plainHttp && !insecureHttp) return { ok: false, error: 'Tick "Allow plain http for this private address" to use http.' };
  return { ok: true, url, plainHttp, host: u.host };
}

/** Does the typed address call for the opt-in checkbox (plain http, private address)? */
export function wantsHttpOptIn(raw: string): boolean {
  const t = raw.trim();
  if (!/^http:\/\//i.test(t)) return false;
  try { return isPrivateHost(new URL(t).hostname); } catch { return false; }
}

/** Does this form ask for a server address? A cloud tile does not; a server-only provider and the "I run my own server" switch do. */
export function asksForUrl(info: ProviderInfo | undefined, form: Pick<ConnectionForm, 'serverUrl'>): boolean {
  return Boolean(info && (info.asksUrl || form.serverUrl));
}

const PEM_RE = /\.(pem|crt|cer)$/i;

export function validateConnectionForm(form: ConnectionForm, info: ProviderInfo | undefined): FormCheck {
  const errors: Partial<Record<FormField, string>> = {};
  const label = form.label.trim();
  if (label.length > 60) errors.label = 'Keep the name under 60 characters.';
  let baseUrl: string | undefined;
  let plainHttp = false;
  let needsHttpOptIn = false;
  if (asksForUrl(info, form)) {
    needsHttpOptIn = wantsHttpOptIn(form.baseUrl) && !form.insecureHttp;
    const r = checkBaseUrl(form.baseUrl, form.insecureHttp);
    if (r.ok) { baseUrl = r.url; plainHttp = r.plainHttp; }
    else if (needsHttpOptIn) errors.insecureHttp = r.error;
    else errors.baseUrl = r.error;
  }
  const ca = form.caBundle.trim();
  if (ca) {
    if (baseUrl && plainHttp) errors.caBundle = 'A CA bundle only applies to https addresses.';
    else if (!PEM_RE.test(ca)) errors.caBundle = 'Use the path of a PEM file (.pem, .crt or .cer).';
  }
  const ok = Object.keys(errors).length === 0;
  const body: CreateBody | undefined = ok ? {
    provider: form.provider,
    ...(label ? { label } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(plainHttp ? { insecureHttp: true } : {}),
    ...(ca ? { caBundle: ca } : {}),
  } : undefined;
  return { ok, errors, needsHttpOptIn, ...(body ? { body } : {}) };
}

/** A name to show as the placeholder: "GitHub", or "GitHub (ghe.example.com)" for a server address. */
export function defaultLabel(info: ProviderInfo | undefined, baseUrl: string): string {
  const name = info?.label ?? 'Connection';
  const r = baseUrl.trim() ? checkBaseUrl(baseUrl, true) : null;
  return r && r.ok ? `${name} (${r.host})` : name;
}

// ── project mapping ──────────────────────────────────────────────────────

export const STATE_ROWS: ReadonlyArray<{ id: string; label: string; hint: string }> = [
  { id: 'backlog', label: 'Backlog', hint: 'Not ready for an agent' },
  { id: 'ready', label: 'Ready', hint: 'Queued for an agent' },
  { id: 'running', label: 'Running', hint: 'An agent is working' },
  { id: 'review', label: 'In review', hint: 'Waiting for you' },
  { id: 'pr', label: 'PR open', hint: 'A pull request is open' },
  { id: 'merged', label: 'Merged', hint: 'Landed' },
  { id: 'blocked', label: 'Blocked', hint: 'Stuck' },
];

export const WORK_ITEM_OPTIONS: ReadonlyArray<{ id: WorkItemSource; label: string; hint: string; valueLabel?: string; placeholder?: string }> = [
  { id: 'off', label: 'Off', hint: 'Do not import work items. Tasks stay on this board.' },
  { id: 'assigned-to-me', label: 'Assigned to me', hint: 'Open items assigned to the account the token acts as.' },
  { id: 'label', label: 'Label', hint: 'Open items that carry this label.', valueLabel: 'Label', placeholder: 'aico' },
  { id: 'query', label: 'Query', hint: 'Open items matching a search in the platform\'s own syntax.', valueLabel: 'Query', placeholder: 'is:open label:bug' },
];

export interface MappingForm {
  connection: string;
  /** "owner/name". */
  repo: string;
  trunk: string;
  landing: LandingMode;
  /** The person accepted the pull request mode card in this form. */
  prConfirmed: boolean;
  source: WorkItemSource;
  value: string;
  stateMap: Record<string, string>;
  /** Comma- or space-separated logins. */
  trustedCommenters: string;
}

export function repoText(repo: { owner: string; name: string } | undefined): string {
  return repo && repo.name ? (repo.owner ? `${repo.owner}/${repo.name}` : repo.name) : '';
}

/** The seven state names, the engine's current ones over its defaults. */
export function stateMapOf(existing?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of STATE_ROWS) out[r.id] = (existing?.[r.id] ?? DEFAULT_STATE_MAP[r.id]) as string;
  return out;
}

export function initialMappingForm(o: { connection: string; existing?: ProjectMapping | undefined; detection?: RepoDetection | null | undefined; trunk?: string | undefined }): MappingForm {
  const e = o.existing;
  return {
    connection: e?.connection ?? o.connection,
    repo: repoText(e?.repo ?? o.detection?.repo),
    trunk: e?.trunk ?? o.detection?.trunk ?? o.trunk ?? 'main',
    landing: e?.landing ?? 'local',
    prConfirmed: false,
    source: e?.workItems.source ?? 'off',
    value: e?.workItems.value ?? '',
    stateMap: stateMapOf(e?.stateMap),
    trustedCommenters: (e?.trustedCommenters ?? []).join(', '),
  };
}

export function parseRepo(text: string): { owner: string; name: string } | null {
  const m = /^\s*([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\s*$/.exec(text);
  return m ? { owner: m[1]!, name: m[2]! } : null;
}

export function parseLogins(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).map(s => s.trim().replace(/^@/, '')).filter(Boolean))];
}

export type MappingErrors = Partial<Record<'repo' | 'trunk' | 'value' | 'landing', string>> & { states?: Record<string, string> };

export function validateMapping(form: MappingForm, policy?: ConnectionsPolicyView): { ok: boolean; errors: MappingErrors } {
  const errors: MappingErrors = {};
  if (!parseRepo(form.repo)) errors.repo = 'Use owner/name, for example acme/shop.';
  const trunk = form.trunk.trim();
  if (!trunk || !/^[A-Za-z0-9._/-]+$/.test(trunk) || trunk.includes('..')) errors.trunk = 'Use the branch name, for example main.';
  const opt = WORK_ITEM_OPTIONS.find(o => o.id === form.source);
  if (opt?.valueLabel && !form.value.trim()) errors.value = `Enter the ${opt.valueLabel.toLowerCase()} to look for.`;
  if (form.landing === 'pr' && !policyView(policy).prAllowed) errors.landing = 'Your organization does not allow pull request mode.';
  const states: Record<string, string> = {};
  for (const r of STATE_ROWS) {
    const v = (form.stateMap[r.id] ?? '').trim();
    if (!v) states[r.id] = 'Enter a name.';
    else if (v.length > 80) states[r.id] = 'Keep it under 80 characters.';
  }
  if (Object.keys(states).length) errors.states = states;
  return { ok: Object.keys(errors).length === 0, errors };
}

/** Switching a project to pull request mode asks the person first; staying in it does not. */
export function landingNeedsConfirm(form: Pick<MappingForm, 'landing'>, existing?: Pick<ProjectMapping, 'landing'> | null): boolean {
  return form.landing === 'pr' && existing?.landing !== 'pr';
}

/** The card the person accepts before pull request mode. The text is the contract; the engine will not accept the switch without the flag the accepting sets. */
export function prConfirmText(repo: string): string {
  return `Pull request mode: AICO will push aico/task-* branches to ${repo || 'the remote'} and open pull requests. It never pushes the trunk, never force-pushes, and the remote's checks and reviews decide when work lands.`;
}

export interface MapBody {
  project: string;
  connection: string;
  repo: { owner: string; name: string };
  workItems: { source: WorkItemSource; value?: string };
  landing: LandingMode;
  trunk: string;
  stateMap: Record<string, string>;
  trustedCommenters?: string[];
  confirmLanding?: true;
}

/** What `connections/map` is sent. `confirmLanding` goes only with a switch to pull request mode the person accepted. */
export function mappingBody(project: string, form: MappingForm, existing?: Pick<ProjectMapping, 'landing'> | null): MapBody | null {
  const repo = parseRepo(form.repo);
  if (!repo) return null;
  const needsConfirm = landingNeedsConfirm(form, existing);
  if (needsConfirm && !form.prConfirmed) return null;
  const opt = WORK_ITEM_OPTIONS.find(o => o.id === form.source);
  const value = opt?.valueLabel ? form.value.trim() : '';
  const logins = parseLogins(form.trustedCommenters);
  const stateMap: Record<string, string> = {};
  for (const r of STATE_ROWS) stateMap[r.id] = (form.stateMap[r.id] ?? '').trim();
  return {
    project, connection: form.connection, repo,
    workItems: { source: form.source, ...(value ? { value } : {}) },
    landing: form.landing, trunk: form.trunk.trim(), stateMap,
    ...(logins.length ? { trustedCommenters: logins } : {}),
    ...(needsConfirm ? { confirmLanding: true as const } : {}),
  };
}

// ── pull requests ────────────────────────────────────────────────────────

/** Failing checks, names first; a check that failed is what a reviewer looks for. */
export function failingChecks(pr: Pick<PullState, 'checks'>): RemoteCheck[] {
  return pr.checks.items.filter(c => c.state === 'failure');
}

export function pendingChecks(pr: Pick<PullState, 'checks'>): RemoteCheck[] {
  return pr.checks.items.filter(c => c.state === 'pending');
}

/** "lint, test and 2 more", clipped; null when none. */
export function nameList(names: readonly string[], show = 2, max = 28): string | null {
  if (!names.length) return null;
  const clip = (s: string): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
  const shown = names.slice(0, show).map(clip).join(', ');
  return names.length > show ? `${shown} +${names.length - show}` : shown;
}

export function failingLine(pr: Pick<PullState, 'checks'>): string | null {
  const names = nameList(failingChecks(pr).map(c => c.name));
  return names ? `Failing: ${names}` : null;
}

function approvalsText(r: PullState['reviews']): string {
  return r.required !== undefined ? `${r.approved} of ${r.required}` : String(r.approved);
}

/**
 * The chips of a task's pull request, in the order a reviewer asks the questions: where it stands,
 * do the checks pass, has anyone approved, can it merge. A merged or closed pull request is just its
 * state; the rest no longer matters.
 */
export function prChips(pr: PullState, opts: { compact?: boolean } = {}): Chip[] {
  if (pr.state === 'merged') return [{ id: 'state', label: 'Merged', tone: 'success', title: 'Merged on the remote.' }];
  if (pr.state === 'closed') return [{ id: 'state', label: 'Closed', tone: 'neutral', title: 'Closed on the remote without merging.' }];
  const out: Chip[] = [];
  if (pr.draft) out.push({ id: 'draft', label: 'Draft', tone: 'neutral', title: 'A draft cannot be merged until it is marked ready on the remote.' });
  switch (pr.checks.state) {
    case 'none': out.push({ id: 'checks', label: 'No checks', tone: 'neutral', title: 'The remote reports no checks for this pull request.' }); break;
    case 'pending': out.push({ id: 'checks', label: 'Checks running', tone: 'info', title: nameList(pendingChecks(pr).map(c => c.name), 6, 40) ?? 'Waiting for the remote\'s checks.' }); break;
    case 'passing': out.push({ id: 'checks', label: 'Checks passing', tone: 'success', title: 'Every check the remote reports has passed.' }); break;
    case 'failing': out.push({ id: 'checks', label: 'Checks failing', tone: 'danger', title: failingLine(pr) ?? 'A check failed on the remote.' }); break;
  }
  const r = pr.reviews;
  switch (r.state) {
    case 'approved': out.push({ id: 'reviews', label: `Approved (${approvalsText(r)})`, tone: 'success', title: 'Reviews the remote requires are in.' }); break;
    case 'changes': out.push({ id: 'reviews', label: 'Changes requested', tone: 'danger', title: `${r.changesRequested} reviewer${r.changesRequested === 1 ? '' : 's'} asked for changes.` }); break;
    case 'pending': out.push({ id: 'reviews', label: r.required !== undefined ? `Awaiting review (${approvalsText(r)})` : 'Awaiting review', tone: 'warning', title: 'Waiting for a reviewer.' }); break;
    case 'none': out.push({ id: 'reviews', label: r.required ? `Approvals ${approvalsText(r)}` : 'No reviews', tone: r.required ? 'warning' : 'neutral', title: r.required ? 'The remote requires approvals before merging.' : 'Nobody has reviewed it, and the remote does not require it.', ...(r.required ? {} : { quiet: true }) }); break;
  }
  if (pr.mergeable === 'conflicting') out.push({ id: 'conflicts', label: 'Conflicts', tone: 'danger', title: 'It conflicts with the target branch. The agent resolves it by merging the trunk into the branch.' });
  else if (pr.canMerge && !pr.draft) out.push({ id: 'ready', label: 'Ready to merge', tone: 'success', title: 'The remote says it can be merged now.' });
  return opts.compact ? out.filter(c => !c.quiet) : out;
}

/** Why the remote will not merge it yet, in words. The remote's own reasons first; ours only when it gave none. */
export function mergeBlockers(pr: PullState): string[] {
  if (pr.state !== 'open' || (pr.canMerge && !pr.draft)) return [];
  const out = pr.mergeBlockers.map(s => s.trim()).filter(Boolean);
  if (out.length) return [...new Set(out)];
  if (pr.draft) out.push('The pull request is still a draft.');
  if (pr.mergeable === 'conflicting') out.push('It conflicts with the target branch.');
  if (pr.checks.state === 'failing') out.push('A check failed.');
  else if (pr.checks.state === 'pending') out.push('Checks have not finished.');
  if (pr.reviews.state === 'changes') out.push('A reviewer asked for changes.');
  else if (pr.reviews.required !== undefined && pr.reviews.approved < pr.reviews.required) {
    const n = pr.reviews.required - pr.reviews.approved;
    out.push(`Needs ${n} more approval${n === 1 ? '' : 's'}.`);
  }
  if (!out.length) out.push('The remote has not said it can be merged yet.');
  return out;
}

/** The Merge button shows only when the remote itself says it can merge now. The remote may still refuse; its answer is shown as written. */
export function canMergeOnRemote(task: { pr?: PullState | undefined }): boolean {
  const pr = task.pr;
  return Boolean(pr && pr.state === 'open' && pr.canMerge && !pr.draft);
}

export function mergeButtonLabel(provider: ProviderId | string | undefined): string {
  return provider ? `Merge on ${providerLabel(provider)}` : 'Merge pull request';
}

export function mergeConfirmText(pr: Pick<PullState, 'id'>, trunk: string): string {
  return `Merge pull request #${String(pr.id).replace(/^#/, '')} into ${trunk}? The remote has confirmed it can be merged.`;
}

/** "PR #12": the short name of a task's pull request. */
export function prName(pr: Pick<PullState, 'id'>): string {
  return `PR #${String(pr.id).replace(/^#/, '')}`;
}

export function prStateWord(pr: Pick<PullState, 'state' | 'draft'>): string {
  return pr.state === 'merged' ? 'Merged' : pr.state === 'closed' ? 'Closed' : pr.draft ? 'Draft' : 'Open';
}

// ── landing wording in the review card ───────────────────────────────────

export interface LandingUi {
  /** The primary button. */
  action: string;
  busy: string;
  /** The high-risk second press. */
  confirm: string;
  /** The small print at the foot of the card. */
  foot: string;
}

/** In pull request mode the review card opens (or updates) a pull request; it does not land on the trunk. */
export function landingUi(landing: LandingMode | undefined, task: { pr?: PullState | undefined }): LandingUi {
  if (landing === 'pr') {
    const update = Boolean(task.pr);
    return {
      action: update ? 'Update pull request' : 'Open pull request',
      busy: update ? 'Updating…' : 'Opening…',
      confirm: `Confirm: ${update ? 'update' : 'open'} a pull request for a high-risk change`,
      foot: 'Pushes an aico/task-* branch and opens a pull request',
    };
  }
  return { action: 'Approve and land', busy: 'Landing…', confirm: 'Confirm: land a high-risk change', foot: 'Lands on the trunk' };
}

/** The review queue's batch button; in pull request mode the same click opens pull requests. */
export function batchLandingLabel(n: number, landing: LandingMode | undefined, busy = false): string {
  if (landing === 'pr') return busy ? `Opening ${n}…` : `Open ${n} pull request${n === 1 ? '' : 's'}`;
  return busy ? `Landing ${n}…` : `Approve and land ${n}`;
}

// ── imported tasks ───────────────────────────────────────────────────────

export interface RemoteChip { text: string; url: string; readyOnRemote: boolean; closed: boolean }

/** "from GitHub #12": where an imported task came from. */
export function remoteChip(remote: RemoteLink | undefined, providerName: string): RemoteChip | null {
  if (!remote) return null;
  return {
    text: `from ${providerName} #${String(remote.id).replace(/^#/, '')}`,
    url: remote.url, readyOnRemote: Boolean(remote.readyOnRemote), closed: remote.remoteState === 'closed',
  };
}

/** Only an http(s) address is opened from a link the remote supplied. */
export function safeExternalUrl(url: string | undefined): string | null {
  if (!url) return null;
  try { const u = new URL(url); return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null; } catch { return null; }
}

// ── the board header ─────────────────────────────────────────────────────

export interface SyncChip { label: string; tone: ChipTone; title?: string; busy: boolean }

export function syncChip(sync: SyncStatus, now: number): SyncChip {
  switch (sync.state) {
    case 'syncing': return { label: 'Syncing…', tone: 'info', busy: true, ...(sync.message ? { title: sync.message } : {}) };
    case 'rate-limited': return { label: 'Rate-limited', tone: 'warning', busy: false, title: sync.message || 'The remote asked AICO to slow down. Syncing resumes by itself.' };
    case 'error': return { label: 'Sync failed', tone: 'danger', busy: false, title: sync.message || 'The last sync did not finish. Try Sync now, or test the connection.' };
    case 'blocked': return { label: 'Blocked by policy', tone: 'warning', busy: false, title: sync.message || 'Your organization\'s policy does not allow this connection.' };
    case 'idle': {
      const when = sync.at ? ago(sync.at, now) : '';
      return { label: when ? `Synced ${when}` : 'Not synced yet', tone: 'neutral', busy: false, ...(sync.message ? { title: sync.message } : {}) };
    }
  }
}

export function boardConnectionLabel(bc: BoardConnection): string {
  return `${providerLabel(bc.provider)} · ${bc.repo}`;
}

export function landingWord(landing: LandingMode): string {
  return landing === 'pr' ? 'Pull requests' : 'Local';
}

export interface SyncResult { imported: number; updated: number; pushed: number; observed: number; conflicts: number; message?: string }

/** What a "Sync now" did, in one sentence. Conflicts say whose version was kept. */
export function syncResultLine(r: SyncResult): string {
  const parts: string[] = [];
  if (r.imported) parts.push(`${r.imported} imported`);
  if (r.updated) parts.push(`${r.updated} updated`);
  if (r.pushed) parts.push(`${r.pushed} pushed`);
  if (r.observed) parts.push(`${r.observed} pull request${r.observed === 1 ? '' : 's'} checked`);
  const base = parts.length ? `Synced: ${parts.join(', ')}.` : 'Already up to date.';
  const conflicts = r.conflicts ? ` ${r.conflicts} conflict${r.conflicts === 1 ? '' : 's'}: the remote's version was kept.` : '';
  return `${base}${conflicts}${r.message ? ` ${r.message}` : ''}`;
}
