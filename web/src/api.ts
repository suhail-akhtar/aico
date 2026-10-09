/**
 * Transport to `aico serve`.
 *
 * Two things here are load-bearing and easy to get wrong:
 *
 * **The token is not in the URL bar.** The server prints a URL with
 * `?token=…`; we take it once, store it, and strip it from the address bar.
 * Leaving it there means it lands in browser history, in any screenshot of the
 * window, and in the `Referer` of every outbound link.
 *
 * It is kept in `localStorage`, not `sessionStorage`. Session storage is
 * per-tab and cleared when the tab closes, so opening a second tab — or coming
 * back tomorrow — presented a stranger with a password prompt for a server
 * they had already authorised. The token is scoped to one origin that is
 * always 127.0.0.1, and it is replaced every time the server restarts.
 *
 * **The stream is resumable, not restartable.** Every logged event carries a
 * monotonic `seq`. On reconnect we ask for `?since=<last seq>` and the server
 * replays the gap from the session log. That is why a dropped connection —
 * closing the laptop, a flaky tunnel — costs nothing: the run kept going
 * server-side and the client catches up. Restarting from zero would double
 * every message instead.
 *
 * `EventSource` is deliberately not used: it cannot send headers, cannot be
 * cancelled cleanly mid-turn, and reconnects on its own schedule with its own
 * idea of where to resume. `fetch` + a reader gives us all three.
 *
 * @module api
 */

import { transportFetch } from './transport';
import type { HostAnswer, HostCall, HostToolName } from '../../shared/host-tools';
import type { CanvasDoc, CanvasSummary, CanvasWriteResult, DeckImageCandidate, DocSettings, ExportFormat } from '../../shared/ui/canvas/host';
import type { DeckImage } from '../../shared/ui/canvas/deck-model';
import type { Board, BoardNote } from '../../shared/ui/board/board-model';
import type { PartEditRequest, PartEditResponse } from '../../shared/ui/canvas/scoped-edit';
import type { CanvasComment, CommentAnchor } from '../../shared/ui/canvas/comments';
import type { ImportReview, ReviewedSkill, SkillProvenance } from './skill-review';

const TOKEN_KEY = 'aico.token';

/** Storage can be unavailable — private mode, blocked cookies, a locked profile. */
function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* see above */ }
}

/**
 * The UI key: the part of the printed link after `#ui=`. The server needs it
 * (traded for a per-client nonce, below) before this window may *allow* a
 * waiting tool call — the token alone may only refuse. A fragment is never
 * sent to a server, so it is not in any request log. See the engine's
 * server/decision-gate.ts.
 */
const UI_KEY = 'aico.uiKey';

/** Pull the token (and the UI key) out of the URL on first load, then hide them. */
export function bootstrapToken(): string | null {
  const url = new URL(window.location.href);
  const hash = new URLSearchParams(url.hash.replace(/^#/, ''));
  const uiKey = hash.get('ui');
  if (uiKey) {
    write(UI_KEY, uiKey);
    hash.delete('ui');
    const rest = hash.toString();
    url.hash = rest ? `#${rest}` : '';
    window.history.replaceState({}, '', url.pathname + url.search + url.hash);
  }
  const fromUrl = url.searchParams.get('token');
  if (fromUrl) {
    write(TOKEN_KEY, fromUrl);
    url.searchParams.delete('token');
    window.history.replaceState({}, '', url.pathname + url.search + url.hash);
    return fromUrl;
  }
  return read(TOKEN_KEY);
}

/** This window's per-client nonce, once the UI key has been traded for one. In memory only. */
let clientNonce: string | null = null;
let attaching: Promise<string | null> | null = null;

/**
 * Trade the UI key for a nonce, once per page. Without a key (the desktop,
 * whose main process forwards decisions itself; the VS Code panel, whose
 * extension host adds the key) there is nothing to trade and null is fine.
 */
export function ensureUiClient(): Promise<string | null> {
  if (clientNonce) return Promise.resolve(clientNonce);
  const key = read(UI_KEY);
  if (!key) return Promise.resolve(null);
  attaching ??= post<{ client?: string }>('ui/attach', { uiKey: key })
    .then((r) => { clientNonce = r.client ?? null; return clientNonce; })
    .catch(() => null)
    .finally(() => { attaching = null; });
  return attaching;
}

export function getToken(): string {
  return read(TOKEN_KEY) ?? '';
}

export function setToken(token: string): void {
  write(TOKEN_KEY, token);
}

/**
 * Forget a token the server no longer accepts.
 *
 * Every restart mints a fresh token, so a remembered one goes stale the moment
 * the server is restarted. Keeping it would 401 every request forever with no
 * explanation; clearing it returns the page to the prompt, which can then say
 * what actually happened.
 */
export function clearToken(): void {
  try { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(UI_KEY); } catch { /* see above */ }
  clientNonce = null;
}

/**
 * Called when the server rejects the stored token.
 *
 * A callback rather than an import of the store, so this module stays a
 * transport and does not need to know what a session is.
 */
let onTokenRejected: (() => void) | undefined;

export function setTokenRejectedHandler(handler: () => void): void {
  onTokenRejected = handler;
}

export class ApiError extends Error {
  /** `body`: the parsed error response, for the routes whose refusal carries data (a canvas conflict). */
  constructor(message: string, readonly status: number, readonly body?: unknown) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await transportFetch(`/api/${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'x-aico-token': getToken(),
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  const body = text ? safeParse(text) : {};
  if (!res.ok) {
    if (res.status === 401) {
      // The server restarted and minted a new token. Forget the old one so the
      // page can ask for the new one instead of failing every request.
      clearToken();
      onTokenRejected?.();
    }
    const message = (body as { error?: string }).error ?? `HTTP ${res.status}`;
    throw new ApiError(message, res.status, body);
  }
  return body as T;
}

function safeParse(text: string): unknown {
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

import type { ParkedAction } from './inbox';
import type { AttentionSnapshot, BatchResult, BoardState, NewTaskInput, Release, ReleasePlan, Task } from './delivery-types';
import type { CgFileDetail, CgPayload, CgSymbolDetail } from './components/codegraph/model';
import type { BriefLatest, Brief, BriefSummaryRow, FixPlanResponse, FixAllResponse } from './brief';
export type { ParkedAction } from './inbox';

/** One Sentinel review as the audit file records it (engine: sentinel/ `SentinelRecord`). */
export interface SentinelVerdictRow {
  at: number;
  sessionId?: string;
  agentName?: string;
  level?: string;
  tool: string;
  effect: string;
  why: string;
  verdict: 'allow' | 'deny' | 'escalate';
  reason: string;
  outcome: 'no-objection' | 'refused' | 'person-allowed' | 'person-refused' | 'parked' | 'refused-unattended';
  model: string;
  costUsd: number;
  ms: number;
  failure?: string;
  call: string;
}

export interface SentinelList {
  verdicts: SentinelVerdictRow[];
  totals: { reviews: number; denied: number; escalated: number; costUsd: number };
}

/** One custom tool as Settings → Tools shows it (engine: custom-tools/manage `toolsForPanel`). */
export interface CustomToolRow {
  name: string;
  pack: string;
  scope: 'user' | 'project';
  file: string;
  status: 'enabled' | 'draft' | 'changed' | 'disabled' | 'invalid' | 'untrusted';
  reason?: string;
  errors: string[];
  warnings: string[];
  /** The exact command or request it runs, secrets by name. */
  command?: string;
  def?: { description: string; effect: string; input_schema: { properties?: Record<string, { type: string; description?: string }> }; preview?: { tool: string } };
}

const post = <T,>(path: string, body: unknown): Promise<T> =>
  request<T>(path, { method: 'POST', body: JSON.stringify(body) });

const get = <T,>(path: string): Promise<T> => request<T>(path, { method: 'GET' });

/**
 * A POST that needs a person, not just the token (server/decision-gate
 * `checkHuman`): enabling an imported skill after its review. Carries this
 * window's client nonce; a nonce the server has forgotten (it restarted, or
 * the tab sat idle) is traded again once before giving up. In the desktop
 * and the VS Code panel there is no nonce to send — their hosts prove the
 * person themselves.
 */
/** One thing a chat made or opened, as `artifacts/list` returns it (engine: `server/artifact-routes`). */
export interface ArtifactItem {
  key: string;
  /** `board`: a design board's board.json (ADR 0037); its `id` is that file's path. */
  kind: 'document' | 'sheet' | 'deck' | 'code' | 'image' | 'file' | 'export' | 'board';
  source: 'canvas' | 'file' | 'attachment';
  /** Canvas id, path inside the chat's artifacts folder, or attachment id. */
  id: string;
  title: string;
  ext?: string;
  language?: string;
  bytes?: number;
  updatedAt: number;
  topic: string;
  uploaded?: boolean;
  /** Where the file is on disk (files and attachments; not canvases) — for Reveal, Copy path, Open with. */
  path?: string;
}

/** What `artifacts/preview` returns: a workbook's cells, or a Word file as plain HTML (no scripts, images inlined). */
export type ArtifactPreview =
  | { type: 'table'; sheets: Array<{ name: string; rows: string[][]; truncated: boolean }> }
  | { type: 'html'; html: string; truncated: boolean };

/** A long job as `longjob/list` returns it (engine: longjob `LongJob`). */
export interface LongJob {
  id: string;
  sessionId: string;
  title: string;
  research: string;
  design: string;
  milestones: Array<{ title: string; detail?: string; acceptance: string[]; doneAt?: number; evidence?: string[] }>;
  estimateHours: number;
  costUsd?: number;
  budget: { usd: number; hours: number };
  missing: string[];
  status: 'pending' | 'declined' | 'superseded' | 'running' | 'paused' | 'done' | 'stopped' | 'budget';
  note?: string;
  spentUsd: number;
  activeMs: number;
  createdAt: number;
}

async function postAsPerson<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const send = async (): Promise<T> => post<T>(path, { ...body, client: await ensureUiClient() ?? undefined });
  try {
    return await send();
  } catch (err) {
    if (err instanceof ApiError && err.status === 403 && (err.body as { code?: string } | undefined)?.code === 'human-required' && clientNonce) {
      clientNonce = null;
      return send();
    }
    throw err;
  }
}

// ── credential vault (engine: src/vault/human.ts) ────────────────────

/** A credential the agent asked a person for. Carries no secret. */
export interface VaultCredentialRequest {
  requestId: string;
  name: string;
  kind: string;
  fields: string[];
  username?: string;
  host?: string;
  url?: string;
  reason: string;
  sessionId?: string;
  /** AICO Desktop is showing its own secure prompt: this client must not open one. */
  hostPrompt?: boolean;
}

/** A stored credential's use waiting for a person's yes. */
export interface VaultApproval {
  id: string;
  credential: { id: string; name: string; kind: string };
  tool: string;
  target?: string;
  purpose: string;
  description: string;
  sessionId?: string;
  mode: 'every-use' | 'session';
  /** How a yes can be proven here: AICO Desktop's own dialog, or the grant passphrase. */
  needs?: 'desktop' | 'passphrase';
}

/** Secrets caught in a message the person sent, moved into the vault. */
export interface VaultQuarantine { items: Array<{ name: string; kind: string; label: string }>; dropped: number }

// ── conversation ─────────────────────────────────────────────────────

export interface SubmitOptions {
  /** Files already uploaded to this session that this turn should reference. */
  attachmentIds?: string[];
  /** Directory to run in. Must be a project the server knows. */
  project?: string;
  sessionId: string;
  task: string;
  model?: string;
  planMode?: boolean;
  autoApprove?: boolean;
  /** How much to ask before acting. Omitted means `auto`, as it always was. */
  approval?: 'full' | 'auto' | 'edits' | 'ask';
  /**
   * This client applies the run's file writes itself.
   *
   * Only say this if you will answer every `edit` event — the tool call blocks
   * until you do.
   */
  applyEdits?: boolean;
  /**
   * Editor-backed tools this client can service, by name.
   *
   * Same contract as `applyEdits`: say it only if you will answer every
   * `host-call` event, because the tool call blocks until you do. Sent per turn
   * rather than per session, because it describes who is driving now — the same
   * conversation reopened in a browser tab has no editor.
   */
  hostTools?: readonly HostToolName[];
  /**
   * How hard to think, for models that can be asked.
   *
   * `auto` and omission both mean "send nothing, let the platform decide" —
   * which for some models is adaptive per request and for others is a fixed
   * level the vendor chose. See `src/reasoning.ts`.
   */
  effort?: 'auto' | 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /**
   * Settle this session's open tasks as part of accepting the message.
   *
   * Sent as a field rather than left for the server to recognise in the
   * message text. The wording is written for the model to read, and prose
   * written to be read is prose that will be reworded — matching on it would
   * put a silent dependency on two sentences staying identical for ever.
   */
  retireTasks?: 'done' | 'cancelled';
  /**
   * The desktop browser's copilot is asking: its turns get the copilot brief
   * and `HandOffToChat`, and not the build-and-run tools. Per turn.
   */
  surface?: 'browser-copilot';
}

/** A chat the browser copilot handed work to (`chat/handoff`, and the `chat-handoff` topic). */
export interface ChatHandOff {
  sessionId: string;
  title: string;
  project: string;
  existing: boolean;
  queued: boolean;
  /** The copilot conversation it came from. */
  from?: string;
}

export interface ChatHandOffRequest {
  task: string;
  fromSessionId?: string;
  project?: string;
  title?: string;
  chat?: string;
  notes?: string;
  /** The page to carry; `null` for none (otherwise the copilot's latest page is used). */
  page?: { url: string; title?: string; selection?: string } | null;
}

export const api = {
  sessions: () => request<{
    sessions: SessionSummary[]; active: string[]; projects: Project[]; groups: Group[];
  }>('sessions'),

  // ── projects ───────────────────────────────────────────────────────
  projects: () => request<{ projects: Project[]; launch: string }>('projects'),

  addProject: (path: string, name?: string) =>
    post<{ project: Project }>('projects/add', { path, name }),

  /** Register a folder only if it already holds chats; `project` is null otherwise. */
  reopenProject: (path: string) =>
    post<{ project: Project | null }>('projects/add', { path, ifHasHistory: true }),

  removeProject: (path: string) => post<{ removed: boolean }>('projects/remove', { path }),

  /**
   * Change what is recorded about a project — label, pin, notes, instructions.
   * The path stays its identity; none of this moves anything.
   */
  updateProject: (path: string, patch: {
    name?: string; pinned?: boolean; color?: string;
    description?: string; instructions?: string;
  }) => post<{ updated: boolean }>('projects/update', { path, ...patch }),

  // ── groups ─────────────────────────────────────────────────────────
  groups: () => request<{ groups: Group[] }>('groups'),

  createGroup: (name: string, cwd?: string) =>
    post<{ group: Group }>('groups/create', { name, cwd }),

  updateGroup: (id: string, patch: {
    name?: string; color?: string; pinned?: boolean;
    description?: string; instructions?: string; cwd?: string;
  }) => post<{ updated: boolean }>('groups/update', { id, ...patch }),

  deleteGroup: (id: string) => post<{ deleted: boolean }>('groups/delete', { id }),

  /** File a session under a group, or `null` to take it out of one. */
  moveToGroup: (sessionId: string, group: string | null) =>
    post<{ moved: boolean }>('session/group', { sessionId, group }),

  /** Subdirectories of one directory, for the picker. */
  browse: (path?: string) =>
    request<BrowseResult>(`fs/browse${path ? `?path=${encodeURIComponent(path)}` : ''}`),

  session: (id: string, project?: string) => request<{
    sessionId: string;
    seq: number;
    busy: boolean;
    messages: Array<{ role: string; content: string }>;
    // Mixed on purpose: counts, two estimate flags, and the window's
    // provenance as a string. Typed loosely here and narrowed where it is read.
    usage: Record<string, unknown>;
    /** The directory this session actually resolved to — always present. */
    project: string;
  }>(`session?id=${encodeURIComponent(id)}${project ? `&project=${encodeURIComponent(project)}` : ''}`),

  // As the person: a mode above the chat's last (full, L4) needs proof of one (engine: server/http-guards).
  submit: (opts: SubmitOptions) => postAsPerson<{ accepted: boolean }>('submit', opts as unknown as Record<string, unknown>),
  /** Move work to a full chat and start it there — the copilot's "Hand off to chat". */
  handOff: (req: ChatHandOffRequest) => post<({ ok: true } & ChatHandOff) | { ok: false; error: string; candidates?: Array<{ title: string; project?: string }> }>('chat/handoff', req),
  cancel: (sessionId: string) => post<{ cancelled: boolean }>('cancel', { sessionId }),
  /** `id` names the message in the `inbox` frames, so the client can follow it to delivery. */
  steer: (sessionId: string, content: string) => post<{ ok: boolean; id?: string }>('steer', { sessionId, content }),
  /** Resolve the question a blocked turn is waiting on. */
  answer: (sessionId: string, content: string) => post<{ ok: boolean }>('answer', { sessionId, content }),

  /**
   * Allow or refuse the tool call a run is blocked on.
   *
   * `id` names the call being decided. A reconnecting client replays the
   * pending request and answers that one; without the id, a decision made
   * about a `Write` could arrive in time to allow whatever is waiting.
   */
  permit: async (sessionId: string, id: string, allow: boolean) =>
    // A yes carries this window's nonce (decision-gate.ts); a no needs nothing.
    post<{ ok: boolean }>('permission', { sessionId, id, allow, ...(allow ? { client: await ensureUiClient() ?? undefined } : {}) }),

  // ── the credential vault's human side (docs/security/credential-broker.md §9) ──

  /** What is waiting on a person: approvals and credential requests (no values in either). */
  vaultStatus: () => get<{ pendingApprovals?: VaultApproval[]; pendingRequests?: VaultCredentialRequest[]; grantPassphrase?: boolean; host?: boolean }>('vault/status'),

  /**
   * Answer a credential request. Write-only: the values go in, a status comes
   * back. The caller must not keep them anywhere (no store, no draft, no log).
   */
  vaultFulfil: (requestId: string, secret: Record<string, string>, username?: string) =>
    post<{ ok: boolean }>('vault/fulfil', { requestId, secret, ...(username ? { username } : {}) }),
  vaultDecline: (requestId: string) => post<{ ok: boolean }>('vault/fulfil', { requestId, decline: true }),

  /**
   * Answer an approval. Approving needs the grant passphrase in a standalone
   * server (the token is not proof of a person); declining needs nothing.
   */
  vaultApprove: (id: string, approve: boolean, opts: { passphrase?: string; scope?: 'once' | 'session' } = {}) =>
    post<{ ok: boolean }>('vault/approve', { id, approve, ...(opts.passphrase ? { passphrase: opts.passphrase } : {}), ...(opts.scope ? { scope: opts.scope } : {}) }),

  /**
   * Report what happened to a write this client was handed.
   *
   * Anything other than `applied: true` becomes a failed tool call, so the
   * model learns the file was not written rather than assuming it was.
   */
  edited: (sessionId: string, id: string, applied: boolean, reason?: string) =>
    post<{ ok: boolean }>('edit', { sessionId, id, applied, reason }),

  /** What the editor did with a host tool call it was handed. */
  hostAnswer: (sessionId: string, id: string, answer: HostAnswer) =>
    post<{ ok: boolean }>('host-answer', { sessionId, ...answer, id }),

  /** What differs from the last commit, with this session's own edits marked. */
  // ── skills ─────────────────────────────────────────────────────────
  skills: () => get<{ skills: SkillSummary[] }>('skills'),
  readSkill: (name: string) =>
    get<{ name: string; body: string }>(`skills/read?name=${encodeURIComponent(name)}`),
  importSkill: (source: string, overwrite = false) =>
    post<{ ok: boolean; name?: string; resources?: string[]; replaced?: boolean; error?: string }>(
      'skills/import', { source, overwrite }),
  /**
   * Install a skill from bytes rather than a path.
   *
   * The path form assumes the browser and the server share a filesystem, which
   * stops being true the moment the portal is opened from another machine —
   * and assumes people know the absolute path of something they just
   * downloaded, which they generally do not.
   */
  uploadSkill: (
    payload: { files?: Array<{ path: string; base64: string }>; markdown?: string; overwrite?: boolean },
  ) =>
    post<{ ok: boolean; name?: string; resources?: string[]; replaced?: boolean; error?: string }>(
      'skills/upload', payload),

  /**
   * Stage an import and get its review back — every skill found, its files,
   * scripts, scan findings and provenance. Nothing is installed.
   */
  reviewSkillImport: (input: { source?: string; files?: Array<{ path: string; base64: string }>; markdown?: string; label?: string }) =>
    post<{ ok: boolean; review?: ImportReview; error?: string }>('skills/review', input),
  /** An installed skill's own review (for "Review and enable"). */
  reviewInstalledSkill: (name: string) =>
    post<{ installed: true; trust: string; trustReason?: string; skill: ReviewedSkill & { provenance?: SkillProvenance } }>('skills/review', { name }),
  /**
   * Install a staged review. `enable: true` is the person's "Install and
   * enable": it needs proof of the person, which this call carries.
   */
  installSkillImport: (input: { id: string; select?: string[]; overwrite?: boolean; enable?: boolean }) =>
    (input.enable ? postAsPerson : post)<SkillInstallOutcome>('skills/install', input),
  discardSkillImport: (id: string) => post<{ ok: boolean }>('skills/discard', { id }),
  /** Enable (or disable) a skill; enabling an unreviewed one is the review, so it goes as the person. */
  setSkillEnabled: (name: string, enabled: boolean) =>
    (enabled ? postAsPerson : post)<ManageResult>('manage', { registry: 'skills', action: enabled ? 'enable' : 'disable', name }),
  /** A skill as Claude's `.skill`: written to `dest` when given, else returned as base64 to download. */
  exportSkill: (name: string, opts: { dest?: string; includeEvals?: boolean } = {}) =>
    post<{ ok: boolean; name?: string; files?: number; path?: string; filename?: string; base64?: string; warnings?: string[]; rewritten?: boolean; error?: string }>(
      'skills/export', { name, ...opts }),
  /** The person's own skill, written in the editor: installed as theirs, without a review. */
  saveAuthoredSkill: (files: Array<{ path: string; base64: string }>, overwrite = false) =>
    postAsPerson<{ ok: boolean; name?: string; resources?: string[]; replaced?: boolean; error?: string }>(
      'skills/upload', { files, overwrite, authored: true }),

  createSkill: (name: string, description: string, body: string) =>
    postAsPerson<{ ok: boolean; name?: string; error?: string }>('skills/create', { name, description, body }),
  removeSkill: (name: string) =>
    post<{ ok: boolean; error?: string }>('skills/remove', { name }),

  // ── measuring a skill ─────────────────────────────────────────────
  skillCorpus: (name: string) =>
    get<SkillCorpus>(`skill-eval/tasks?name=${encodeURIComponent(name)}`),
  startSkillEval: (input: { skill: string; model: string; budgetUsd: number; maxIterations?: number }) =>
    post<SkillJob | { error: string }>('skill-eval/run', input),
  startSkillOptimize: (input: {
    skill: string; model: string; budgetUsd: number; steps: number;
    candidates?: number; maxEdits?: number; optimizerModel?: string; maxIterations?: number;
  }) => post<SkillJob | { error: string }>('skill-eval/optimize', input),
  skillJob: (id: string) => get<SkillJob>(`skill-eval/job?id=${encodeURIComponent(id)}`),
  cancelSkillJob: (id: string) => post<{ cancelled: boolean }>('skill-eval/cancel', { id }),
  adoptSkillCandidate: (id: string) => post<{ ok: boolean; message: string }>('skill-eval/adopt', { id }),

  // ── mcp ────────────────────────────────────────────────────────────
  addMcpServer: (config: Record<string, unknown>) =>
    postAsPerson<{ ok: boolean; result?: string; error?: string }>('mcp/add', config),
  removeMcpServer: (name: string) =>
    post<{ ok: boolean; result?: string; error?: string }>('mcp/remove', { name }),
  reloadMcpServers: () =>
    post<{ ok: boolean; result?: string; error?: string }>('mcp/reload', {}),
  /** What a pasted config means, checked before anything is written. */
  validateMcpConfig: (json: string) => post<McpConfigCheck>('mcp/validate', { json }),

  // ── registries ─────────────────────────────────────────────────────
  //
  // One call for every verb on every registry, hitting the same executors the
  // agent uses. The panel is a second front door to one implementation rather
  // than a parallel one that has to be kept in step.
  manage: (registry: 'skills' | 'agents' | 'mcp' | 'memory' | 'tools', input: Record<string, unknown>) =>
    postAsPerson<ManageResult>('manage', { registry, ...input }),

  // ── custom tools (Settings → Tools) ────────────────────────────────
  customTools: () => get<{ tools: CustomToolRow[] }>('custom-tools'),
  /**
   * Enable, test (executes a read tool) and delete are a person's acts, so
   * they go with the proof of the person; disable is safe on the token alone.
   */
  customToolAction: (action: 'enable' | 'disable' | 'test' | 'delete', name: string, args?: Record<string, unknown>) =>
    (action === 'disable' ? post : postAsPerson)<ManageResult>('manage', { registry: 'tools', action, name, ...(args ? { args } : {}) }),
  memories: (scope?: string) =>
    get<{ memories: MemorySummary[] }>(`memory${scope && scope !== 'all' ? `?scope=${encodeURIComponent(scope)}` : ''}`),

  /** Start or stop a process app's own process. */
  runMiniApp: (slug: string, action: 'start' | 'stop', opts?: { docker?: boolean; mode?: 'compose' | 'native' }) =>
    post<MiniAppProcess | { stopped: boolean }>('apps/run', { slug, action, ...(opts ?? {}) }),

  /** What an app can start from: the shipped templates plus the user's and the project's. */
  templates: () => get<{ templates: AppTemplate[] }>('apps/templates'),

  /** Templates ranked against a brief, with the words that matched, and a suggested name. */
  suggestApps: (brief: string) =>
    get<{ suggested: Array<{ id: string; matched: string[] }>; name: string }>(`apps/suggest?brief=${encodeURIComponent(brief)}`),
  /** Two levels of an app's files, for the workspace panel. */
  appFiles: (slug: string) => get<{ files: Array<{ path: string; dir: boolean; size?: number }> }>(`apps/files?slug=${encodeURIComponent(slug)}`),
  /** One text file inside an app, read-only. */
  appFile: (slug: string, filePath: string) =>
    get<{ path: string; content: string; truncated: boolean }>(`apps/file?slug=${encodeURIComponent(slug)}&path=${encodeURIComponent(filePath)}`),

  /** A copy of an app under a new name: files and profiles, not its data or install. */
  duplicateApp: (slug: string, title?: string) =>
    post<{ slug: string; app: MiniAppSummary; from: string }>('apps/duplicate', { slug, ...(title ? { title } : {}) }),

  /** What the last turns proposed, for the Suggested section. Nothing here is in effect. */
  learning: (cwd?: string, status: 'open' | 'adopted' | 'dismissed' | 'all' = 'open') =>
    get<{ cwd: string; project: Proposal[]; global: Proposal[] }>(
      `learning/list?status=${status}${cwd ? `&cwd=${encodeURIComponent(cwd)}` : ''}`),
  /** Keep a proposal, with edits: writes knowledge, a profile fact, or a line about the user. */
  adoptProposal: (cwd: string | undefined, id: string, edits: { trigger?: string; content?: string; scope?: 'project' | 'global' }) =>
    postAsPerson<{ ok: true; wrote: string }>('learning/adopt', { cwd, id, ...edits }),
  dismissProposal: (cwd: string | undefined, id: string) =>
    post<{ ok: true; id: string }>('learning/dismiss', { cwd, id }),

  /** What AICO learned about how you work (ADR 0016): every rule, and which apply to `cwd`. */
  preferences: (cwd?: string) =>
    get<{ cwd: string; rules: PreferenceRule[]; applying: string[]; pending: number }>(
      `learning/preferences${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''}`),
  /**
   * Change one rule. Putting a rule in force (accept, enable, edit, add) is
   * sent as a person — the engine refuses it on the API token alone;
   * disabling and forgetting are always allowed.
   */
  preferenceAct: (body: { action: 'accept' | 'enable' | 'disable' | 'forget' | 'edit' | 'add'; id?: string; text?: string; scope?: string; cwd?: string }) =>
    (body.action === 'disable' || body.action === 'forget' ? post : postAsPerson)<{ ok: true; rule?: PreferenceRule }>(
      'learning/preferences/act', body as Record<string, unknown>),
  preferencesExport: () =>
    get<{ exportedAt: string; format: string; rules: PreferenceRule[] }>('learning/preferences/export'),

  /** About you (engine: profile/, ADR 0018). Confirm/edit/add/run/widening need a person; hide/forget/narrowing do not. */
  profile: () => get<import('./profile').ProfileOverview>('profile'),
  profileAct: (body: { id: string; action: 'confirm' | 'hide' | 'unhide' | 'forget' | 'edit'; text?: string }) =>
    (body.action === 'hide' || body.action === 'forget' ? post : postAsPerson)<{ ok: true }>('profile/act', body as Record<string, unknown>),
  profileAdd: (category: string, text: string) => postAsPerson<{ ok: true }>('profile/add', { category, text }),
  profileRun: () => postAsPerson<{ ok: boolean; started?: boolean }>('profile/run', {}),
  profileSettings: (patch: { enabled?: boolean; work?: boolean; browsing?: boolean; dailyBudgetUsd?: number }) =>
    (Object.values(patch).some(v => v === true || typeof v === 'number') ? postAsPerson : post)<{ ok: true }>('profile/settings', patch),
  profileExport: () => get<Record<string, unknown>>('profile/export'),
  profileWipe: () => post<{ ok: true; removed: number }>('profile/wipe', {}),

  /** The morning brief and monitors (engine: brief/). Reads, a manual run, per-project monitor switches. */
  brief: () => get<BriefLatest>('brief/latest'),
  briefHistory: (limit = 14) => get<{ briefs: BriefSummaryRow[] }>(`brief/history?limit=${limit}`),
  briefById: (id: string) => get<{ brief: Brief }>(`brief/history?id=${encodeURIComponent(id)}`),
  runBrief: () => post<{ ok: boolean; started?: boolean; error?: string }>('brief/run', {}),
  /** Fix all: the plan (a read), then the start (needs a person; the keys are item keys of the latest brief). */
  briefFixPlan: (keys: string[]) => post<FixPlanResponse>('brief/fix-plan', { keys }),
  briefFixAll: (keys: string[]) => postAsPerson<FixAllResponse>('brief/fix-all', { keys }),
  setBriefMonitor: (path: string, flags: { ci?: boolean; reviews?: boolean; advisories?: boolean; codeGraph?: boolean }) =>
    post<{ ok: boolean }>('brief/monitors', { path, ...flags }),

  /** The approve-later inbox: calls unattended runs parked for a person (engine: autonomy/inbox). */
  inbox: (status: 'pending' | 'all' = 'all') =>
    get<{ actions: ParkedAction[]; pending: number }>(`inbox/list?status=${status}`),
  /** Approving runs the exact parked call once, so it is sent as a person; denying needs no proof. */
  decideParked: (id: string, decision: 'approve' | 'deny', note?: string) =>
    (decision === 'approve' ? postAsPerson : post)<{ ok: boolean; message: string; action?: ParkedAction }>(
      'inbox/decide', { id, decision, ...(note ? { note } : {}) }),

  /** The Sentinel's recent verdicts and totals (engine: sentinel/, ADR 0015). Read-only. */
  sentinel: (limit = 30) => get<SentinelList>(`sentinel/list?limit=${limit}`),
  /**
   * Delivery (engine: src/delivery, routes /api/delivery/*): a work board where agents take
   * tasks in parallel and a person reviews and lands their work. Starting the dispatcher,
   * approving (which lands the branch) and requesting changes are a person's act, so they go
   * as a person; everything else is a plain call.
   */
  deliveryBoard: (project: string) => get<BoardState>(`delivery/board?project=${encodeURIComponent(project)}`),
  deliveryCreate: (input: NewTaskInput) => post<Task>('delivery/tasks', input),
  deliveryUpdate: (id: string, project: string, patch: Partial<Pick<Task, 'title' | 'body' | 'acceptance' | 'status' | 'priority' | 'dependsOn' | 'labels'>>) =>
    request<Task>(`delivery/tasks/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ project, ...patch }) }),
  deliveryPlan: (project: string, brief: string) => post<{ sessionId: string }>('delivery/plan', { project, brief }),
  deliveryDispatch: (project: string, action: 'start' | 'pause', maxParallel?: number) =>
    postAsPerson<BoardState>('delivery/dispatch', { project, action, ...(maxParallel ? { maxParallel } : {}) }),
  deliveryApprove: (id: string, project: string) =>
    postAsPerson<Task>(`delivery/tasks/${encodeURIComponent(id)}/approve`, { project }),
  deliveryRequestChanges: (id: string, project: string, comment: string) =>
    postAsPerson<Task>(`delivery/tasks/${encodeURIComponent(id)}/request-changes`, { project, comment }),
  deliveryDiff: (id: string, project: string) =>
    get<{ diff: string }>(`delivery/tasks/${encodeURIComponent(id)}/diff?project=${encodeURIComponent(project)}`),
  /** Land several low-risk, green tasks with one yes; the engine refuses the whole set if any is not eligible. */
  deliveryApproveBatch: (project: string, ids: string[]) => postAsPerson<BatchResult>('delivery/approve-batch', { project, ids }),
  /** A person's note on a task's thread (it reaches the agent's prompt as the person's word). */
  deliveryComment: (id: string, project: string, text: string) =>
    postAsPerson<Task>(`delivery/tasks/${encodeURIComponent(id)}/comment`, { project, text }),
  /** The releases the board made, and what a release would be now (`version` previews a version you chose). */
  deliveryReleases: (project: string, version?: string) =>
    get<{ releases: Release[]; plan: ReleasePlan }>(`delivery/releases?project=${encodeURIComponent(project)}${version ? `&version=${encodeURIComponent(version)}` : ''}`),
  /** Make the release: version bump, notes, a local annotated tag. A person's act. */
  deliveryRelease: (project: string, opts: { version?: string; changelog?: boolean } = {}) =>
    postAsPerson<Release>('delivery/releases', { project, ...opts }),
  /** Run the project's deploy command for a release. A person's act. */
  deliveryDeploy: (project: string, version: string) =>
    postAsPerson<Release>(`delivery/releases/${encodeURIComponent(version)}/deploy`, { project }),
  /** Create the task that reverts a release's commits; it goes through the normal queue. A person's act. */
  deliveryRollback: (project: string, version: string) =>
    postAsPerson<Task>(`delivery/releases/${encodeURIComponent(version)}/rollback`, { project }),
  /** Compact state of every board, for notifications. */
  deliveryAttention: () => get<AttentionSnapshot>('delivery/attention'),


  /** Long jobs (engine: longjob/): proposals over the size threshold and the jobs they became. */
  longJobs: (sessionId: string) =>
    get<{ jobs: LongJob[] }>(`longjob/list?sessionId=${encodeURIComponent(sessionId)}`),
  /** Approving starts paid work across turns, so it is sent as a person; declining needs no proof. */
  decideLongJob: (id: string, decision: 'approve' | 'decline') =>
    (decision === 'approve' ? postAsPerson : post)<{ ok: boolean; message: string; job?: LongJob }>('longjob/decide', { id, decision }),
  /** Resuming spends again, so it goes as a person; pausing and stopping are always safe. */
  controlLongJob: (id: string, action: 'pause' | 'resume' | 'stop') =>
    (action === 'resume' ? postAsPerson : post)<{ ok: boolean; message: string; job?: LongJob }>('longjob/control', { id, action }),

  /** Which cheap model the read-only sub-agent roles could run on, for the model in use. */
  agentRecommendation: (model?: string) =>
    get<AgentRecommendation>(`agents/recommendation${model ? `?model=${encodeURIComponent(model)}` : ''}`),

  /** Which model does which job (engine: models/roles, ADR 0017). Choices are written with `saveSettingPath('models.…')`. */
  modelRoles: (model?: string) =>
    get<ModelRolesView>(`models/roles${model ? `?model=${encodeURIComponent(model)}` : ''}`),

  /** Run the app's own deploy script. A missing requirement answers 400 with `missing`. */
  deployApp: (slug: string, target?: string) =>
    post<{ deploy: MiniAppProcess }>('apps/deploy', { slug, ...(target ? { target } : {}) }),
  deployStatus: (slug: string) =>
    get<{ deploy: MiniAppProcess | null }>(`apps/deploy?slug=${encodeURIComponent(slug)}`),

  /** The commands a project is held to, with provenance. Reading bootstraps the file from the manifest. */
  projectProfile: (cwd?: string) =>
    get<ProjectProfileView>(`project/profile${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''}`),
  /** Set one command by hand — `user` rank, which nothing observed or detected can undo. */
  setProjectCommand: (cwd: string | undefined, name: string, command: string) =>
    post<ProjectProfileView>('project/profile', { cwd, name, command }),
  forgetProjectCommand: (cwd: string | undefined, name: string) =>
    post<ProjectProfileView>('project/profile', { cwd, name, forget: true }),
  /** A workspace's commit history, newest first, paginated by the hash to continue before. */
  gitLog: (path: string, opts: { limit?: number; before?: string } = {}) => {
    const params = new URLSearchParams({ path });
    if (opts.limit) params.set('limit', String(opts.limit));
    if (opts.before) params.set('before', opts.before);
    return get<GitLogPage>(`project/git-log?${params.toString()}`);
  },
  /** One commit: files, message and diff. */
  gitShow: (path: string, hash: string) =>
    get<CommitDetail>(`project/git-show?${new URLSearchParams({ path, hash }).toString()}`),
  /** Local branches, the current one marked. */
  gitBranches: (path: string) =>
    get<BranchList>(`project/git-branches?${new URLSearchParams({ path }).toString()}`),
  /** Switch branch, branch from a commit, or revert one. Refused on a dirty tree. */
  gitAction: (path: string, action: 'switch' | 'branch' | 'revert', opts: { name?: string; at?: string; switchTo?: boolean }) =>
    post<BranchList & { ok: true }>('project/git-action', { path, action, ...opts }),
  /** The working tree: staged, unstaged, untracked and conflicted files, and the upstream. */
  gitStatus: (path: string) =>
    get<GitStatus>(`project/git-status?${new URLSearchParams({ path }).toString()}`),
  /** One file's diff — staged or not; an untracked file comes back as all-added. */
  gitDiff: (path: string, file: string, staged: boolean) =>
    get<{ diff: string; truncated: boolean }>(`project/git-diff?${new URLSearchParams({ path, file, staged: staged ? '1' : '0' }).toString()}`),
  gitStashes: (path: string) =>
    get<{ stashes: Array<{ ref: string; message: string; date: string }> }>(`project/git-stashes?${new URLSearchParams({ path }).toString()}`),
  /** Every other git move: stage, unstage, discard, commit, push, pull, fetch, stash, branches, init. */
  gitRun: (path: string, action: GitRunAction, opts: { name?: string; paths?: string[] | 'all'; message?: string; all?: boolean; includeUntracked?: boolean; ref?: string } = {}) =>
    post<BranchList & { ok: true; detail?: unknown; status: GitStatus }>('project/git-action', { path, action, ...opts }),
  /** Remove chats for good. Running ones are refused and reported. */
  deleteSessions: (ids: string[]) =>
    post<{ deleted: string[]; skipped: Array<{ id: string; reason: string }> }>('sessions/delete', { ids }),
  /** Totals across every session a workspace has ever had. */
  projectStats: (path: string) =>
    get<ProjectStats>(`project/stats?path=${encodeURIComponent(path)}`),
  /** The Code map (engine codegraph routes, ADR 0028): registered projects only. */
  codeGraph: (path: string, refresh = false) =>
    get<CgPayload>(`codegraph/graph?path=${encodeURIComponent(path)}${refresh ? '&refresh=1' : ''}`),
  codeGraphVersion: (path: string) =>
    get<{ version: string; files: number }>(`codegraph/version?path=${encodeURIComponent(path)}`),
  codeGraphFile: (path: string, file: number) =>
    get<CgFileDetail>(`codegraph/file?path=${encodeURIComponent(path)}&file=${file}`),
  codeGraphSymbol: (path: string, file: number, name: string) =>
    get<CgSymbolDetail>(`codegraph/symbol?path=${encodeURIComponent(path)}&file=${file}&name=${encodeURIComponent(name)}`),
  codeGraphSymbols: (path: string, q: string) =>
    get<{ symbols: Array<{ file: number; name: string; kind: string; line: number }> }>(`codegraph/symbols?path=${encodeURIComponent(path)}&q=${encodeURIComponent(q)}`),
  codeGraphDiff: (path: string) =>
    get<{ changed: string[]; ids: number[] }>(`codegraph/diff?path=${encodeURIComponent(path)}`),
  codeGraphMermaid: (path: string) =>
    get<{ mermaid: string }>(`codegraph/mermaid?path=${encodeURIComponent(path)}`),
  codeGraphContext: (path: string, ids: number[]) =>
    get<{ text: string }>(`codegraph/context?path=${encodeURIComponent(path)}&ids=${ids.join(',')}`),
  /**
   * Open a file at a line in the person's editor (server/editor): needs a person,
   * like approving a tool call. `opened: false` comes with the reason; the
   * client then shows its own viewer.
   */
  openInEditor: (file: string, line?: number, project?: string) =>
    postAsPerson<{ opened: boolean; editor?: string; reason?: string; rel?: string; line?: number }>('editor/open', { file, ...(line ? { line } : {}), ...(project ? { path: project } : {}) }),
  /** A registered project's text file, for the viewer. */
  projectFile: (file: string, project?: string) =>
    get<{ path: string; root: string; text: string; size: number }>(`editor/file?file=${encodeURIComponent(file)}${project ? `&path=${encodeURIComponent(project)}` : ''}`),
  /**
   * Make an app from a template. The server also binds its conversation and,
   * for a process app, starts the install in the background — so the answer
   * carries the session to open, not just the slug.
   */
  createApp: (input: { template: string; title: string; description?: string; install?: boolean }
    | { custom: true; title: string; description?: string }) =>
    post<{ slug: string; sessionId: string; app: MiniAppSummary; notice?: string }>('apps/create', input),

  /** Stop one sub-agent without cancelling the turn its siblings are in. */
  stopSubAgent: (agentId: string, reason: string) =>
    post<{ stopped: boolean }>('agents/stop', { agentId, reason }),

  miniApps: () => get<MiniAppsView>('miniapps'),
  /**
   * Open (or rejoin) the conversation about one Mini App.
   *
   * The server derives the session id from the slug, so coming back to an app
   * comes back to what you were already saying about it.
   */
  openMiniAppSession: (slug: string) =>
    post<{ sessionId: string; slug: string }>('miniapps/session', { slug }),
  /** Destructive: the app's database goes with it. */
  deleteMiniApp: (slug: string) => post<{ deleted: boolean }>('miniapps/delete', { slug }),

  changes: (sessionId: string) => get<ChangesReport>(`changes?id=${encodeURIComponent(sessionId)}`),
  changesDiff: (sessionId: string, file: string) =>
    get<{ diff: string }>(`changes/diff?id=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(file)}`),
  /** Destructive. `deleteUntracked` is required for a file that was never committed. */
  revert: (sessionId: string, file: string, deleteUntracked = false) =>
    post<{ ok: boolean; deleted?: boolean; error?: string }>(
      'changes/revert', { sessionId, path: file, deleteUntracked }),
  followup: (sessionId: string, content: string) => post<{ ok: boolean; id?: string }>('followup', { sessionId, content }),
  /** Take a queued message back before its turn starts. False when it already started. */
  withdrawFollowup: (sessionId: string, id: string) => post<{ ok: boolean }>('followup', { sessionId, withdraw: id }),

  trajectory: (sessionId: string, opts: { limit?: number; before?: number } = {}) => {
    const params = new URLSearchParams({ id: sessionId });
    if (opts.limit) params.set('limit', String(opts.limit));
    if (opts.before !== undefined) params.set('before', String(opts.before));
    return request<TrajectoryView>(`trajectory?${params}`);
  },

  setGoal: (sessionId: string, text: string, status: 'active' | 'paused' | 'cleared') =>
    post<{ ok: boolean }>('goal', { sessionId, text, status }),

  rate: (sessionId: string, targetSeq: number, rating: 'up' | 'down' | 'none', note?: string) =>
    post<{ ok: boolean }>('feedback', { sessionId, targetSeq, rating, note }),

  /**
   * Keep a correction as knowledge the agent will see again.
   *
   * `trigger` is when it applies; `content` is the guidance. Filed with the
   * session's project unless `scope` is `global`.
   */
  addKnowledge: (sessionId: string, entry: {
    trigger: string; content: string; id?: string; scope?: 'project' | 'global';
  }) => post<{ ok: boolean; id: string; path: string; scope: 'project' | 'global' }>(
    'knowledge/add', { sessionId, ...entry },
  ),

  agents: () => request<{ agents: AgentSpec[] }>('agents'),

  /** Files attached to a session, held until the turn that uses them. */
  uploadAttachment: (sessionId: string, name: string, base64: string, mimeType?: string) =>
    post<{ ok: boolean; attachment?: Attachment; error?: string }>(
      'attachments/upload', { sessionId, name, base64, ...(mimeType ? { mimeType } : {}) }),
  removeAttachment: (sessionId: string, id: string) =>
    post<{ ok: boolean; error?: string }>('attachments/remove', { sessionId, id }),

  /** Address a session to one specialist, or `null` for the orchestrator. */
  setSessionAgent: (sessionId: string, name: string | null) =>
    post<{ ok: boolean; agent?: string; error?: string }>('agent', { sessionId, name }),

  /**
   * Record the model this session should use from here on.
   *
   * The choice used to live only in this tab, so it lasted until a reload and
   * then reverted to the global default without saying anything. Writing it to
   * the log is what makes it survive, and what lets two sessions differ.
   */
  setSessionModel: (sessionId: string, model: string | null) =>
    post<{ ok: boolean; error?: string }>('model', { sessionId, model }),

  /** URL of the transcript as a downloadable document. */
  exportUrl: (sessionId: string, format: 'md' | 'txt') =>
    `/api/session/export?id=${encodeURIComponent(sessionId)}&format=${format}`
    + `&token=${encodeURIComponent(getToken())}`,

  /** The transcript as text, for copying to the clipboard. */
  exportText: async (sessionId: string, format: 'md' | 'txt'): Promise<string> => {
    const res = await fetch(
      `/api/session/export?id=${encodeURIComponent(sessionId)}&format=${format}`,
      { headers: { 'x-aico-token': getToken() } },
    );
    if (!res.ok) throw new ApiError(`export failed: ${res.status}`, res.status);
    return res.text();
  },

  rename: (sessionId: string, title: string) =>
    post<{ renamed: boolean }>('session/rename', { sessionId, title }),

  archive: (sessionId: string, archived: boolean) =>
    post<{ archived: boolean }>('session/archive', { sessionId, archived }),

  /** Branch a session: same history so far, a new id to continue from. */
  fork: (sessionId: string, throughTurn?: number) =>
    post<{ id: string; title?: string; project?: string }>('session/fork', {
      sessionId, ...(throughTurn === undefined ? {} : { throughTurn }),
    }),

  // ── providers ──────────────────────────────────────────────────────
  providers: () => request<{
    instances: ProviderInstance[];
    types: ProviderTypeInfo[];
    active: string | null;
    model: string | null;
  }>('providers'),

  saveProvider: (instance: Partial<ProviderInstance>) =>
    post<{ instance: ProviderInstance }>('providers/save', { instance }),

  deleteProvider: (id: string) => post<{ deleted: boolean }>('providers/delete', { id }),
  /** What Auto reasoning sends, per provider family — see shared/reasoning FAMILY_REASONING. */
  providerTuning: () => get<{ families: Record<string, string> }>('providers/tuning'),
  setProviderTuning: (type: string, choice: string) =>
    post<{ type: string; choice: string }>('providers/tuning', { type, choice }),

  activateProvider: (id: string, model?: string) =>
    post<{ active: string; model: string | null }>('providers/activate', { id, model }),

  /**
   * What the active provider can run.
   *
   * Answers from the instance's stored catalogue when it has one and asks the
   * endpoint when it does not, remembering the result either way.
   */
  providerModels: (id?: string) =>
    post<{
      models: string[]; source: 'stored' | 'fetched' | 'none';
      /** Per-model input/output modalities, keyed by id. Absent on older servers. */
      capabilities?: Record<string, {
        input: string[]; output: string[]; chat: boolean; known: boolean;
        /**
         * Which answer this is: a person's override, a live probe, the
         * provider's catalogue, the built-in table, or the text-only default.
         * Absent on older servers.
         */
        source?: 'user' | 'probe' | 'catalogue' | 'table' | 'assumed';
        /** When a probe or catalogue answer was established (ms). */
        checkedAt?: number;
      }>;
      provider?: string; defaultModel?: string | null; error?: string;
    }>('providers/models', id ? { id } : {}),

  /**
   * Test an instance that already exists, by id. Naming a model also probes
   * whether it reads images — one small real request.
   */
  testProvider: (id: string, model?: string) =>
    post<ProviderTestResult>('providers/test', model ? { id, model } : { id }),

  /**
   * Find out whether a model reads images by sending it a tiny picture, and
   * remember the answer. Costs one small request; never run automatically.
   */
  probeModel: (model: string, provider?: string) =>
    post<ModelImageProbe & { model: string; provider: string; recorded: boolean }>(
      'models/probe', provider ? { model, provider } : { model }),

  /** Test what is being typed, before it is saved. */
  testProviderDraft: (draft: { type: string; apiKey?: string; baseUrl?: string }) =>
    post<ProviderTestResult>('providers/test', draft),

  settings: () => request<Record<string, unknown>>('settings'),
  /** Which settings the organisation's managed policy locks (ADR 0035). An older engine has no such route. */
  policy: () => request<ManagedPolicyView>('policy'),
  // As the person: a write that widens what the agent may do needs proof of one (engine: api-system safetyWeakening).
  saveSettings: (patch: Record<string, unknown>) => postAsPerson<Record<string, unknown>>('settings', patch),
  /** One value by dotted path, in the user's own file only; `undefined` removes it. */
  saveSettingPath: (path: string, value: unknown) =>
    postAsPerson<Record<string, unknown>>('settings/path', { path, value: value === undefined ? null : value }),

  /** What the server believes this model's window is, and why. */
  contextWindow: (model: string) =>
    get<{ model: string; tokens: number; source: WindowSource }>(`context-window?model=${encodeURIComponent(model)}`),
  /** Set the window by hand, or `null` to forget an override and let detection try again. */
  setContextWindow: (model: string, tokens: number | null) =>
    post<{ model: string; tokens: number; source: WindowSource; cleared?: boolean }>('context-window', { model, tokens }),

  system: () => request<SystemSnapshot>('system'),
  cancelBackgroundAgent: (agentId: string) => post<{ cancelled: boolean }>('background/cancel', { agentId }),
  /** Stop anything in the ledger by id — agent, process, watcher or schedule. */
  stopWork: (id: string, reason?: string) =>
    post<{ stopped: boolean; state: string; reason?: string }>('work/stop', { id, reason }),
  ackWork: (id: string[]) => post<{ acknowledged: number }>('work/ack', { id }),
  cronAction: (action: 'delete' | 'pause' | 'resume', jobId: string) =>
    post<Record<string, unknown>>(`cron/${action}`, { jobId }),

  // ── canvas ─────────────────────────────────────────────────────────
  canvasList: (sessionId: string) =>
    get<{ canvases: CanvasSummary[] }>(`canvas/list?session=${encodeURIComponent(sessionId)}`),
  canvasGet: (sessionId: string, id: string, light = false) =>
    get<{ canvas: CanvasDoc }>(`canvas/get?session=${encodeURIComponent(sessionId)}&id=${encodeURIComponent(id)}${light ? '&light=1' : ''}`),
  /** A person's edit. A stale `baseVersion` answers 409 with the current document — see {@link canvasWrite}. */
  canvasSave: (sessionId: string, id: string, content: string, baseVersion: number, note?: string, tab?: string) =>
    canvasWrite('canvas/save', { session: sessionId, id, content, baseVersion, ...(note ? { note } : {}), ...(tab ? { tab } : {}) }),
  canvasRestore: (sessionId: string, id: string, version: number, baseVersion?: number, tab?: string) =>
    canvasWrite('canvas/restore', { session: sessionId, id, version, ...(baseVersion !== undefined ? { baseVersion } : {}), ...(tab ? { tab } : {}) }),
  /** AICO Docs tabs: add, rename, delete. See docs/engineering/canvas-docs-contract.md. */
  canvasTabs: (sessionId: string, id: string, op: { op: 'add' | 'rename' | 'delete'; tab?: string; title?: string; content?: string }) =>
    post<{ canvas: CanvasDoc }>('canvas/tabs', { session: sessionId, id, ...op }),
  canvasSettings: (sessionId: string, id: string, docSettings: DocSettings) =>
    post<{ canvas: CanvasDoc }>('canvas/settings', { session: sessionId, id, settings: docSettings }),
  canvasCreate: (sessionId: string, input: { title: string; content: string; kind?: 'document' | 'code' | 'sheet' | 'deck' }) =>
    post<{ canvas: CanvasDoc }>('canvas/create', { session: sessionId, kind: 'document', ...input }),
  canvasRename: (sessionId: string, id: string, title: string) =>
    post<{ canvas: CanvasDoc }>('canvas/rename', { session: sessionId, id, title }),
  /** A scoped AI edit (ADR 0024): a validated proposal for one part; nothing is written. Cancelled by `signal`. */
  canvasEditPart: (sessionId: string, id: string, body: PartEditRequest, signal?: AbortSignal) =>
    request<PartEditResponse>('canvas/edit-part', { method: 'POST', body: JSON.stringify({ session: sessionId, id, ...body }), ...(signal ? { signal } : {}) }),
  /** A .xlsx/.csv as a new sheet canvas; `data` is base64. */
  canvasImport: (sessionId: string, file: { name: string; data: string }) =>
    post<{ canvas: CanvasDoc }>('canvas/import', { session: sessionId, ...file }),
  // ── Deck pictures and brand (server/deck-visual-routes, ADR 0025) ──
  deckImageSearch: (query: string, opts: { orientation?: string; slot?: { w: number; h: number } } = {}) =>
    post<{ candidates: DeckImageCandidate[]; notes: string[]; providers: string[] }>('deck/images/search', { query, ...opts }),
  deckImagePlace: (url: string) => post<{ image: DeckImage }>('deck/images/place', { url }),
  deckImageUpload: (file: { name: string; data: string }) => post<{ image: DeckImage }>('deck/images/upload', file),
  deckProjectImages: (sessionId: string) => get<{ files: { path: string; bytes: number }[] }>(`deck/images/project?session=${encodeURIComponent(sessionId)}`),
  deckProjectImage: (sessionId: string, path: string) => post<{ image: DeckImage }>('deck/images/project', { session: sessionId, path }),
  deckBrand: (url: string, theme: string) => post<{ brand: { url: string; name?: string; colors: string[]; font?: string; notes: string[] }; palette: Record<string, string> }>('deck/brand', { url, theme }),
  // ── Artifacts (server/artifact-routes): what this chat made or opened ──
  artifactsList: (sessionId: string) =>
    get<{ artifacts: ArtifactItem[] }>(`artifacts/list?session=${encodeURIComponent(sessionId)}`),
  artifactRename: (sessionId: string, path: string, name: string) =>
    post<{ path: string }>('artifacts/rename', { session: sessionId, path, name }),
  /** A file from the chat's artifacts folder (`path`) or its attachments (`attachment` id), as a blob. */
  artifactFile: async (sessionId: string, ref: { path?: string; attachment?: string }): Promise<Blob> => {
    const q = ref.attachment
      ? `attachments/file?session=${encodeURIComponent(sessionId)}&id=${encodeURIComponent(ref.attachment)}`
      : `artifacts/file?session=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(ref.path ?? '')}`;
    const res = await transportFetch(`/api/${q}`, { headers: { 'x-aico-token': getToken() } });
    if (!res.ok) throw new Error(`could not fetch the file (${res.status})`);
    return res.blob();
  },
  // ── Design boards (server/board-routes, ADR 0037) ──
  /** A board, normalised by the engine, with the problems it found. `path` is its board.json in the artifacts folder. */
  boardGet: (sessionId: string, path: string) =>
    get<{ board: Board; problems: string[] }>(`boards/get?session=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(path)}`),
  boardNotes: (sessionId: string, path: string, notes: BoardNote[]) =>
    post<{ notes: BoardNote[] }>('boards/notes', { session: sessionId, path, notes }),
  /** A screen as PNG, the board as PDF, or its folder as a zip — drawn by the engine's headless browser. */
  boardExport: async (sessionId: string, path: string, format: 'png' | 'pdf' | 'zip', frame?: string): Promise<{ blob: Blob; name: string }> => {
    const q = `session=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(path)}&format=${format}${frame ? `&frame=${encodeURIComponent(frame)}` : ''}`;
    const res = await transportFetch(`/api/boards/export?${q}`, { headers: { 'x-aico-token': getToken() } });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const body = text ? safeParse(text) as { error?: string } : {};
      throw new ApiError(body.error ?? `HTTP ${res.status}`, res.status, body);
    }
    const cd = res.headers.get('content-disposition') ?? '';
    const name = /filename\*=UTF-8''([^;]+)/i.exec(cd)?.[1] ?? /filename="?([^";]+)"?/i.exec(cd)?.[1];
    return { blob: await res.blob(), name: name ? decodeURIComponent(name) : `board.${format}` };
  },
  /** A spreadsheet's cells or a Word file's content, read by the engine for the Artifacts viewer. */
  artifactPreview: (sessionId: string, ref: { path?: string; attachment?: string }) =>
    get<ArtifactPreview>(`artifacts/preview?session=${encodeURIComponent(sessionId)}&${ref.attachment
      ? `attachment=${encodeURIComponent(ref.attachment)}` : `path=${encodeURIComponent(ref.path ?? '')}`}`),
  canvasComments: (sessionId: string, id: string) =>
    get<{ comments: CanvasComment[] }>(`canvas/${encodeURIComponent(id)}/comments?session=${encodeURIComponent(sessionId)}`),
  canvasComment: (sessionId: string, id: string, input: { tabId: string; anchor: CommentAnchor; body: string; askAgent?: boolean }) =>
    post<{ comment: CanvasComment }>(`canvas/${encodeURIComponent(id)}/comments`, { session: sessionId, ...input }),
  canvasCommentReply: (sessionId: string, id: string, commentId: string, body: string) =>
    post<{ comment: CanvasComment }>(`canvas/${encodeURIComponent(id)}/comments/${encodeURIComponent(commentId)}/replies`, { session: sessionId, body }),
  canvasCommentResolve: (sessionId: string, id: string, commentId: string, resolved: boolean) =>
    post<{ comment: CanvasComment }>(`canvas/${encodeURIComponent(id)}/comments/${encodeURIComponent(commentId)}/resolve`, { session: sessionId, resolved }),
  /**
   * A tab exported by the engine, as bytes. Not the JSON `request`: the body is
   * a file, and a JSON error only arrives when it failed.
   */
  canvasExport: async (sessionId: string, id: string, format: ExportFormat, tab?: string, settings?: DocSettings): Promise<{ blob: Blob; name: string }> => {
    const q = `session=${encodeURIComponent(sessionId)}&format=${format}${tab ? `&tab=${encodeURIComponent(tab)}` : ''}`
      + `${settings ? `&settings=${encodeURIComponent(JSON.stringify(settings))}` : ''}`;
    const res = await transportFetch(`/api/canvas/${encodeURIComponent(id)}/export?${q}`, { headers: { 'x-aico-token': getToken() } });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const body = text ? safeParse(text) as { error?: string } : {};
      throw new ApiError(body.error ?? `HTTP ${res.status}`, res.status, body);
    }
    const cd = res.headers.get('content-disposition') ?? '';
    const name = /filename\*=UTF-8''([^;]+)/i.exec(cd)?.[1] ?? /filename="?([^";]+)"?/i.exec(cd)?.[1];
    return { blob: await res.blob(), name: name ? decodeURIComponent(name) : `canvas.${format}` };
  },
};

/**
 * A canvas write, with a conflict as an answer rather than an error.
 *
 * A 409 here is the normal "the agent wrote while you typed" case and carries
 * the current document; the editor needs that document to offer a choice, so
 * it is returned, not thrown.
 */
async function canvasWrite(path: string, body: unknown): Promise<CanvasWriteResult> {
  try {
    const r = await post<{ ok: true; changed: boolean; canvas: CanvasDoc }>(path, body);
    return { ok: true, canvas: r.canvas, changed: r.changed };
  } catch (err) {
    const canvas = (err as ApiError).body as { canvas?: CanvasDoc } | undefined;
    if (err instanceof ApiError && err.status === 409 && canvas?.canvas) return { ok: false, conflict: true, canvas: canvas.canvas };
    throw err;
  }
}

/** What `GET /api/policy` returns: the organisation's managed policy, never a secret (ADR 0035). */
export interface ManagedPolicyView {
  managed: boolean;
  lockdown: boolean;
  hash: string;
  message?: string;
  contact?: string;
  sources: Array<{ origin: string; path: string; exists: boolean; weakness?: string; error?: string }>;
  problems: Array<{ level: string; key?: string; message: string }>;
  locked: Array<{ path: string; kind: 'fixed' | 'bounded' | 'restricted'; reason: string; value?: unknown }>;
  rules: string[];
}

export interface ProviderTestResult {
  ok: boolean;
  error?: string;
  models?: string[];
  latencyMs?: number;
  /** The root that answered, when the probe had to correct the one supplied. */
  baseUrl?: string;
  /** Input modalities the catalogue stated, by model id. Sparse; absent on older servers. */
  inputModalities?: Record<string, string[]>;
  /** Present when the test named a model: whether it read the probe image. */
  imageProbe?: ModelImageProbe | { error: string };
}

/** What showing a model a tiny solid-colour picture found out. */
export interface ModelImageProbe {
  /** `unknown` records nothing — a failed or ambiguous probe is not evidence. */
  verdict: 'image' | 'text-only' | 'unknown';
  reason: string;
  colour: string;
  answer?: string;
  error?: string;
  latencyMs?: number;
}

/** One configured provider, as the server reports it — never with a key. */
export interface ProviderInstance {
  id: string;
  type: 'openrouter' | 'deepseek' | 'kimi' | 'anthropic' | 'openai' | 'gemini' | 'zai' | 'ollama' | 'openai-compatible';
  name: string;
  apiKey?: string;
  baseUrl?: string;
  models?: string[];
  defaultModel?: string;
  enabled?: boolean;
  keySource?: 'settings' | 'environment' | 'none' | 'not-required';
  derived?: boolean;
}

/** One adapter family: its label, defaults, and when to pick it. */
export interface ProviderTypeInfo {
  type: ProviderInstance['type'];
  label: string;
  defaultBaseUrl: string;
  defaultModel: string;
  envVar?: string;
  requiresKey: boolean;
  hint: string;
}

/** One row in the session sidebar. */
/** A directory the client may start sessions in. */
export interface Project {
  path: string;
  name: string;
  /** Kept above recency in the list. */
  pinned?: boolean;
  /** Swatch tinting the folder icon. */
  color?: string;
  /** A note about the folder. Shown here, never sent to a model. */
  description?: string;
  /** Instructions every session in this folder follows. */
  instructions?: string;
  /** The directory the server was launched in. Cannot be removed. */
  isLaunch: boolean;
  /** The synthetic fallback offered when no project is chosen ("Scratch"). */
  isWorkspace: boolean;
  /** False once the directory has been deleted or renamed underneath us. */
  exists: boolean;
  sessions: number;
  updatedAt: number;
  /** When the folder was added, so a new one sorts to the top. */
  addedAt?: number;
}

/**
 * A container you made, as opposed to one the filesystem made for you.
 *
 * A group never replaces a session's working directory, so one group can hold
 * sessions from several projects — which is the only version of this worth
 * having. If a group were just another folder, the folders would already do it.
 */
export interface Group {
  id: string;
  name: string;
  color?: string;
  description?: string;
  /** Instructions every session in this group follows. */
  instructions?: string;
  pinned?: boolean;
  /** Where sessions started from this group run. Unset means "wherever you are". */
  cwd?: string;
  createdAt?: number;
}

export interface BrowseResult {
  path: string;
  parent: string | null;
  entries: Array<{ name: string; path: string }>;
  roots: Array<{ name: string; path: string }>;
  /** The directory could not be read. `entries` is empty, and that is not an error. */
  denied?: boolean;
}

export interface SessionSummary {
  id: string;
  /** Id of the group this session is filed under, when it is in one. */
  group?: string;
  /** Absolute path of the project this session belongs to. */
  project?: string;
  /** Filed away — still on disk, just not in the list. */
  archived?: boolean;
  title?: string;
  titleSource?: 'fallback' | 'model' | 'user';
  updatedAt: number;
  /** User messages in the log. Zero means nothing has been written yet. */
  turns?: number;
  running?: boolean;
  open?: boolean;
}

/** One event as the log recorded it. */
export interface LogEvent {
  seq: number;
  type: string;
  timestamp: number;
  data: Record<string, unknown>;
}

export interface StepTiming {
  turn: number;
  step: number;
  startedAt: number;
  firstTokenAt?: number;
  endedAt?: number;
  ttftMs?: number;
  decodeMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
}

export interface Deliverable {
  path: string;
  action: 'created' | 'modified';
  seq: number;
  touches: number;
}

export interface Goal {
  text: string;
  status: 'active' | 'paused' | 'cleared';
  since: number;
}

export interface Feedback {
  rating: 'up' | 'down';
  note?: string;
  at: number;
}

export interface TrajectoryView {
  events: LogEvent[];
  steps: StepTiming[];
  deliverables: Deliverable[];
  total: number;
  hasMore: boolean;
  goal: Goal | null;
  feedback: Record<number, Feedback>;
}

/** One subagent the harness can delegate to. */
export interface AgentSpec {
  name: string;
  description: string;
  role: string;
  goals: string[];
  skills: string[];
  tools: string[];
  canDelegate: boolean;
  source: string;
  /** False when switched off: still defined, just not offered. */
  enabled: boolean;
  model?: string;
  /** Agents v2 (`.md` agents): its own instructions and enforced bounds. */
  instructions?: string;
  disallowedTools?: string[];
  mcpServers?: string[];
  delegate?: 'none' | 'readonly' | string[];
  autonomy?: 'L0' | 'L1' | 'L2' | 'L3' | 'L4';
  budget?: { maxUsd?: number; maxIterations?: number; maxMinutes?: number };
  paths?: { write?: string[] };
  format?: 'md' | 'json';
  warnings?: string[];
  /** Phase 4: whether it holds a certificate for exactly what it is now (gates unattended runs). */
  certification?: { status: 'uncertified' | 'certified' | 'changed' | 'failed'; text: string; at?: string };
}

/** What `AgentManage validate` returns: the engine's errors, warnings and summary. */
export interface AgentCheck {
  ok: boolean;
  errors: string[];
  warnings: string[];
  summary?: {
    name: string; level: string; tools: string[]; runsWithoutAsking: string[]; asksFirst: string[];
    cannot: string[]; delegation: string; budget: string; writes: string; unattended: string; notes: string[]; text: string;
  };
}

/** Where the agent writes files that are not part of the project. */
export interface WorkspaceInfo {
  root: string;
  configured: boolean;
  sessionDir?: string;
}

export interface FileChange {
  path: string;
  kind: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';
  from?: string;
  added: number;
  removed: number;
  binary: boolean;
  /** True when a tool in this session wrote it. */
  bySession: boolean;
}

/**
 * One sub-agent, as the server sees it right now.
 *
 * Mirrors `SubAgentRecord` minus the fields only the engine needs. Sent whole
 * on every change rather than as a diff: the set is small, changes are frequent
 * but cheap, and a diff protocol here would be three times the code to save
 * bytes nobody is counting.
 */
export interface SubAgentView {
  agentId: string;
  description: string;
  agentType: string;
  model: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  /** The tool it is on, phrased for reading — "Read…", "Bash…". */
  statusMessage: string;
  startedAt: number;
  completedAt?: number;
  toolCallCount: number;
  inputTokens: number;
  outputTokens: number;
  error?: string;
  /** 1 for a child of this turn, 2 for a grandchild. */
  depth: number;
}

/** A template an app can start from, as the catalogue route describes it. */
export interface AppTemplate {
  id: string;
  version: string;
  name: string;
  category: string;
  kind: AppKind;
  summary: string;
  /** Three short lines of what the app arrives with. */
  features?: string[];
  tags?: string[];
  match?: string[];
  requires?: { node?: string };
  /** The toolchain a non-Node (or any) stack needs. */
  toolchain?: { id: 'node' | 'python' | 'java' | 'dotnet' | 'go' | 'php'; version?: string };
  /** A bundle's parts. */
  services?: Array<{ id: string; role: string; template?: string; path?: string; image?: string }>;
  run?: { install?: string; dev?: string };
  deploy?: Array<{ id: string; label: string; requires?: string[] }>;
  source: 'bundled' | 'user' | 'project';
  /** Whether this machine can run it, from a real toolchain probe: `docker` means a container would stand in. */
  availability?: { ok: boolean; message: string; docker: boolean };
}

/** A lesson the log proposed, waiting for a person. Mirrors `learning/extract` on the server. */
/** A rule about how the user works (engine: learning/preferences.ts). */
export interface PreferenceRule {
  id: string;
  text: string;
  topic: string;
  /** `global`, `project:<root>` or `language:<name>`. */
  scope: string;
  category: 'style' | 'tooling' | 'workflow' | 'communication';
  status: 'proposed' | 'active' | 'disabled' | 'superseded';
  evidence: Array<{ sessionId: string; seq?: number; kind: 'feedback' | 'correction' | 'edit' | 'choice'; excerpt: string; at: number }>;
  createdAt: number;
  updatedAt: number;
  acceptedAt?: number;
  autoAccepted?: boolean;
  replaces?: string[];
  supersededBy?: string;
  byUser?: boolean;
}

export interface Proposal {
  id: string;
  kind: 'knowledge' | 'profile' | 'user';
  trigger?: string;
  content: string;
  why: string;
  needsEdit: boolean;
  evidence: { sessionId: string; seqs: number[]; turn?: number };
  scope: 'project' | 'global';
  status: 'open' | 'adopted' | 'dismissed';
  createdAt: number;
  expiresAt: number;
}

/** Which cheap model the read-only sub-agent roles could run on. */
/** One model role as the engine resolved it (models/roles `RoleResolution` plus what the page shows). */
export interface ModelRoleRow {
  role: string;
  label: string;
  does: string;
  personal: boolean;
  needs: 'chat' | 'vision' | 'image-out' | 'embedding';
  model: string;
  source: 'override' | 'role' | 'legacy' | 'preset' | 'default' | 'off';
  ok: boolean;
  local: boolean;
  fellBack?: string;
  note?: string;
  provider: string | null;
  price: { input: number; output: number; known: boolean } | null;
  /** The person's own `models.roles[role]`, if any. */
  chosen: string | null;
  spent: { usd: number; calls: number } | null;
}

export interface ModelRolesView {
  mainModel: string;
  preset: 'balanced' | 'economy' | 'quality' | 'private';
  localOnlyPersonal: boolean;
  roles: ModelRoleRow[];
  suggestions: string[];
}

export interface AgentRecommendation {
  workModel: string;
  family?: string;
  cheap?: string;
  agentModels: Record<string, string>;
  alreadySet: string[];
  roles: Array<{ role: string; why: string }>;
}

/** Where a profile fact came from; a person's word outranks everything else. */
export type ProfileSource = 'user' | 'template' | 'observed' | 'detected';

export interface ProjectProfileView {
  cwd: string;
  names: string[];
  profile: {
    version: 1;
    stack?: { value: string; source: ProfileSource; at: string };
    packageManager?: { value: string; source: ProfileSource; at: string };
    commands: Record<string, { command: string; source: ProfileSource; at: string; port?: number } | undefined>;
  };
}

export interface CommitInfo {
  hash: string;
  shortHash: string;
  author: string;
  /** ISO 8601, author date. */
  date: string;
  subject: string;
}

export interface CommitDetail {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  subject: string;
  body: string;
  files: Array<{ status: string; path: string }>;
  diff: string;
  truncated: boolean;
}

export type GitRunAction = 'new-branch' | 'delete-branch' | 'stage' | 'unstage' | 'discard' | 'commit' | 'push' | 'pull' | 'fetch' | 'stash' | 'stash-pop' | 'init' | 'switch';

export interface GitStatusEntry { path: string; from?: string; index: string; worktree: string }

export interface GitStatus {
  isRepo: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: GitStatusEntry[];
  unstaged: GitStatusEntry[];
  untracked: GitStatusEntry[];
  conflicted: GitStatusEntry[];
  remotes: string[];
}

export interface BranchList {
  current: string | null;
  branches: Array<{ name: string; current: boolean; lastCommit: string; lastDate: string }>;
}

export interface GitLogPage {
  cwd: string;
  isRepo: boolean;
  commits: CommitInfo[];
  hasMore: boolean;
}

/** Totals across every session a workspace has ever had. */
export interface ProjectStats {
  cwd: string;
  sessions: number;
  turns: number;
  costUsd: number;
  firstActive: number | null;
  lastActive: number | null;
  byDay: Array<{ date: string; count: number }>;
}

/** What runs an app: the shared host (page, static), its own process, or nothing served (cli). */
export type AppKind = 'page' | 'static' | 'process' | 'cli' | 'mobile' | 'nextjs' | 'bundle';

/** How a process app's process is doing. Page and static apps have none. */
export interface MiniAppProcess {
  slug: string;
  state: 'stopped' | 'installing' | 'starting' | 'running' | 'failed' | 'working' | 'done';
  port?: number;
  url?: string;
  error?: string;
  /** The tail of what the process printed — the whole content of "it broke". */
  output: string[];
  startedAt: number;
  /** On the machine's toolchain, in a container, or as a compose project. */
  mode?: 'native' | 'docker' | 'compose';
  /** A bundle's services, each with its own state and log tail. */
  services?: Array<{ id: string; role: string; state: 'pending' | 'installing' | 'starting' | 'running' | 'failed' | 'stopped'; port?: number; url?: string; error?: string; output: string[] }>;
}

export interface MiniAppSummary {
  slug: string;
  /** The effective kind; absent in old manifests means page. */
  kind?: AppKind;
  /** The shelf it sits on in the Apps screen. */
  category?: string;
  /** Where it came from, when it came from a template. */
  template?: { id: string; version: string };
  title: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
  sessionId?: string;
  /** False until the app has a page; a claimed directory is not yet an app. */
  built: boolean;
  /** Stories ticked in .aico/backlog.md, when it has one. */
  backlog?: { done: number; total: number };
  /** Deploy targets the app ships with, from app.json. */
  deploy?: Array<{ id: string; label: string; script?: string; requires?: string[] }>;
  /** The stack facts a templated app carries (toolchain, manifest file, container image). */
  stack?: { toolchain?: { id: string; version?: string }; manifestFile?: string | string[] };
  /** A bundle's services. */
  services?: Array<{ id: string; role: string }>;
}

export interface MiniAppsView {
  enabled: boolean;
  /** Why the host is not listening, when it should be — a taken port, usually. */
  error?: string;
  /**
   * The host's address, or null when the plugin is off or failed to bind.
   * Null is the difference between "here are your apps" and a list of links
   * that go nowhere, so the panel branches on it rather than guessing a port.
   */
  host: string | null;
  apps: MiniAppSummary[];
  /** Process state, for the apps that have a process. */
  processes?: MiniAppProcess[];
}

export interface ChangesReport {
  isRepo: boolean;
  files: FileChange[];
  added: number;
  removed: number;
  reverted: string[];
}

export interface SkillSummary {
  name: string;
  /** The sentence the agent selects on. */
  description: string;
  builtin: boolean;
  /**
   * Whether it may reach the model: `unreviewed` imports are on disk but out
   * of the catalogue until a person reviews and enables them.
   */
  trust?: 'builtin' | 'authored' | 'reviewed' | 'unreviewed';
  trustReason?: string;
  /** Where an imported skill came from, its hash, and its scan totals. */
  provenance?: SkillProvenance;
  /** Spec problems found on load; shown, never blocking. */
  warnings?: string[];
  compatibility?: string;
  aliases: string[];
  allowedTools: string[];
  license?: string;
  version?: string;
  author?: string;
  resources: string[];
  path: string;
  enabled: boolean;
  trigger?: string;
}

export interface Attachment {
  id: string;
  name: string;
  extension: string;
  mimeType: string;
  bytes: number;
}

export interface McpConfigCheck {
  ok: boolean;
  servers: Array<{ name: string; type: string; summary: string }>;
  problems: string[];
}

/** Every registry verb answers the same way: did it work, and what happened. */
export interface SkillInstallOutcome {
  ok: boolean;
  installed: Array<{ name: string; installedAt: string; replaced: boolean; trust: 'reviewed' | 'unreviewed' }>;
  skipped: Array<{ name: string; reason: string }>;
  error?: string;
}

export interface ManageResult {
  ok: boolean;
  result?: string;
  error?: string;
}

export interface MemorySummary {
  id: string;
  scope: 'global' | 'project' | 'session';
  text: string;
  tags: string[];
  /** False when silenced: still stored, withheld from the agent. */
  enabled: boolean;
  updatedAt: number;
  belongsTo?: string;
}

export interface SystemSnapshot {
  backgroundAgents: Array<{
    agentId: string; description: string; model: string;
    status: string; statusMessage: string; startedAt: number;
    completedAt?: number; toolCallCount: number; currentTool?: string;
    resultPreview?: string; error?: string;
  }>;
  cron: Array<{
    id: string; schedule: string; prompt?: string; task?: string;
    paused?: boolean; nextRun?: number;
    permissions?: 'full' | 'readonly' | 'inherit';
    /**
     * What the last firing did — state, spend, and its outcome.
     *
     * From the work ledger rather than the cron store, because the store only
     * knows when a job last *started*. A schedule that reports its next fire
     * time and nothing else is how a job that had been failing every night for
     * a week still looked healthy.
     */
    lastOutcome?: string;
  }>;
  worktrees: Array<{ path?: string; branch?: string; agentId?: string; [k: string]: unknown }>;
  skills: Array<{ name: string; description: string; builtin: boolean }>;
  mcpServers: Array<{
    name: string;
    enabled: boolean;
    /** What it is actually contributing right now, not merely that it is configured. */
    health: string;
    toolCount: number;
    resourceCount: number;
  }>;
  workspace?: WorkspaceInfo;
  /**
   * Everything the work ledger holds — one list across sub-agents, background
   * agents, scheduled firings, backgrounded processes, Mini App servers and
   * watchers. Live work first, then what recently settled.
   */
  work?: WorkRow[];
}

export interface WorkRow {
  id: string;
  kind: 'agent' | 'run' | 'process' | 'watcher' | 'schedule' | 'remote';
  title: string;
  state: 'queued' | 'running' | 'blocked' | 'done' | 'failed' | 'cancelled' | 'lost';
  origin: 'user' | 'model' | 'cron' | 'remote' | 'watcher';
  parent?: string;
  startedAt: number;
  endedAt?: number;
  heartbeatAt: number;
  steps?: number;
  lastTool?: string;
  note?: string;
  costUsd?: number;
  pid?: number;
  reported: boolean;
  outcome?: string;
}

// ── the event stream ─────────────────────────────────────────────────

/**
 * A tool call waiting on a decision.
 *
 * `id` is what makes a decision safe to act on. Tool calls can run in parallel
 * and a client can reconnect mid-prompt, so a bare yes could otherwise be
 * applied to a call other than the one that was shown.
 */
export interface PermissionRequest {
  id: string;
  tool: string;
  /** The command, path or URL — whatever the call is actually about. */
  detail: string;
  /** Present for the write tools, so a diff can be shown before allowing it. */
  fileDiff?: { path: string; added?: string[]; removed?: string[]; preview?: string };
}

/** A file write the client was asked to apply itself. */
/** Re-exported so a client can name the type without a second import path. */
export type { HostAnswer, HostCall, HostToolName };
export type { ImportReview, ReviewedSkill, SkillProvenance };

/** Where a context-window figure came from. Mirrors the server's `WindowSource`. */
export type WindowSource = 'user' | 'api' | 'learned' | 'observed' | 'table' | 'assumed';

export interface SkillCorpus {
  skill: string;
  tasks: Array<{ id: string; split: 'train' | 'val'; checks: number; builtin: boolean }>;
  train: number;
  val: number;
}

export interface SkillJobTask {
  id: string;
  score: number;
  checks: Array<{ check: { kind: string; why: string }; passed: boolean }>;
  output: string;
  toolCalls: string[];
  costUsd: number;
  error?: string;
  phase?: 'train' | 'val';
}

export interface SkillJobStep {
  step: number;
  trainMean: number;
  candidateTrainMean?: number;
  candidates?: number;
  proposed: Array<{ find: string; replace: string; reason: string }>;
  dropped: Array<{ edit: { reason: string }; because: string }>;
  valMean?: number;
  accepted: boolean;
  costUsd: number;
}

/** One evaluation or optimisation, as the server reports it while it runs. */
export interface SkillJob {
  id: string;
  kind: 'eval' | 'optimize';
  skill: string;
  model: string;
  startedAt: number;
  phase: string;
  tasks: SkillJobTask[];
  steps: SkillJobStep[];
  costUsd: number;
  done: boolean;
  cancelled: boolean;
  error?: string;
  report?: { mean: number; tasks: SkillJobTask[]; overBudget: boolean; costUsd: number };
  outcome?: {
    baselineValMean: number;
    bestValMean: number;
    improved: boolean;
    best?: string;
    stoppedBecause?: string;
  };
}

export interface EditRequest {
  id: string;
  /** Absolute path, already resolved inside the workspace by the engine. */
  path: string;
  /** The whole intended contents. `before` is not sent — the client has it. */
  after: string;
}

export interface StreamEvent {
  type: string;
  sessionId: string;
  seq?: number;
  data: Record<string, unknown>;
}

export interface StreamHandle {
  close: () => void;
}

/** A frame on a topic stream: `full`, `processes` or `changed` for the Apps screen. */
export interface TopicEvent<T = unknown> {
  type: string;
  topic: string;
  data: T;
}

/**
 * Subscribe to a topic stream, reconnecting forever.
 *
 * The same reader `streamSession` uses, for state that is not a
 * conversation's — which apps are running, say. There is no resume point:
 * the server sends a full frame on every connect, so a reconnect is a refresh.
 */
export function streamTopic<T = unknown>(
  path: string,
  onEvent: (event: TopicEvent<T>) => void,
  onStatus?: (status: 'connecting' | 'live' | 'lost') => void,
): StreamHandle {
  let closed = false;
  let attempt = 0;
  let controller: AbortController | null = null;

  const connect = async (): Promise<void> => {
    if (closed) return;
    onStatus?.('connecting');
    controller = new AbortController();
    try {
      const res = await transportFetch(
        `/api/${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(getToken())}`,
        { signal: controller.signal, headers: { Accept: 'text/event-stream' } },
      );
      if (!res.ok || !res.body) throw new ApiError(`stream failed: ${res.status}`, res.status);
      attempt = 0;
      onStatus?.('live');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary: number;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const line = frame.split('\n').find(l => l.startsWith('data: '));
          if (!line) continue;
          try { onEvent(JSON.parse(line.slice(6)) as TopicEvent<T>); } catch { /* a bad frame is not a dead stream */ }
        }
      }
    } catch (err) {
      if (closed || (err as Error)?.name === 'AbortError') return;
    }
    if (closed) return;
    onStatus?.('lost');
    attempt += 1;
    setTimeout(connect, Math.min(1000 * 2 ** (attempt - 1), 15_000));
  };

  void connect();
  return { close: () => { closed = true; controller?.abort(); } };
}

/** The Apps screen's stream: one full frame, then process state and list changes. */
/** Hand-offs from the browser copilot to a chat, as they happen (no replay). */
export function streamHandOffs(
  onEvent: (event: TopicEvent<ChatHandOff>) => void,
  onStatus?: (status: 'connecting' | 'live' | 'lost') => void,
): StreamHandle {
  return streamTopic('chat/handoff/events', onEvent, onStatus);
}

export function streamApps(
  onEvent: (event: TopicEvent<MiniAppsView | { processes: MiniAppProcess[] } | Record<string, never>>) => void,
  onStatus?: (status: 'connecting' | 'live' | 'lost') => void,
): StreamHandle {
  return streamTopic('apps/events', onEvent, onStatus);
}

/**
 * Subscribe to a session, reconnecting from the last seen `seq` forever.
 *
 * The retry delay backs off but is capped: a server that is merely restarting
 * should be picked up in seconds, and a user watching a long run should not
 * have to reload the page because the reconnect timer wandered into minutes.
 */
export function streamSession(
  sessionId: string,
  onEvent: (event: StreamEvent) => void,
  onStatus?: (status: 'connecting' | 'live' | 'lost') => void,
  /** Resume point. Pass the last seq already applied; 0 replays everything. */
  startSeq = 0,
  /**
   * Directory this session belongs to.
   *
   * Sent on subscribe as well as on submit because subscribing is what opens
   * the session server-side — a brand-new session has no row on disk yet, so
   * the server has no other way to learn which project it is for, and would
   * file it under the directory it was launched in.
   */
  project?: string,
): StreamHandle {
  let closed = false;
  let since = startSeq;
  let attempt = 0;
  let controller: AbortController | null = null;

  const connect = async (): Promise<void> => {
    if (closed) return;
    onStatus?.(attempt === 0 ? 'connecting' : 'connecting');
    controller = new AbortController();

    try {
      // The stream is what makes this window's nonce "connected" to the
      // session, so it is obtained first and named here.
      const client = await ensureUiClient();
      const res = await transportFetch(
        `/api/events?session=${encodeURIComponent(sessionId)}&since=${since}`
        + `&token=${encodeURIComponent(getToken())}`
        + (client ? `&client=${encodeURIComponent(client)}` : '')
        + (project ? `&project=${encodeURIComponent(project)}` : ''),
        { signal: controller.signal, headers: { Accept: 'text/event-stream' } },
      );
      if (!res.ok || !res.body) throw new ApiError(`stream failed: ${res.status}`, res.status);

      attempt = 0;
      onStatus?.('live');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE frames are separated by a blank line. Anything after the last
        // separator is a partial frame and must stay in the buffer.
        let boundary: number;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const line = frame.split('\n').find(l => l.startsWith('data: '));
          if (!line) continue;
          try {
            const event = JSON.parse(line.slice(6)) as StreamEvent;
            // Only logged events advance the resume point. Streaming deltas
            // have no seq and are not replayed — treating them as a resume
            // point would skip real history on the next reconnect.
            if (typeof event.seq === 'number' && event.seq > since) since = event.seq;
            onEvent(event);
          } catch {
            // A malformed frame is not a reason to tear down a working stream.
          }
        }
      }
    } catch (err) {
      if (closed || (err as Error)?.name === 'AbortError') return;
    }

    if (closed) return;
    onStatus?.('lost');
    attempt += 1;
    const delay = Math.min(1000 * 2 ** (attempt - 1), 15_000);
    setTimeout(connect, delay);
  };

  void connect();

  return {
    close: () => {
      closed = true;
      controller?.abort();
    },
  };
}
