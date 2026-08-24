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

const TOKEN_KEY = 'aico.token';

/** Storage can be unavailable — private mode, blocked cookies, a locked profile. */
function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* see above */ }
}

/** Pull the token out of the URL on first load, then hide it. */
export function bootstrapToken(): string | null {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get('token');
  if (fromUrl) {
    write(TOKEN_KEY, fromUrl);
    url.searchParams.delete('token');
    window.history.replaceState({}, '', url.pathname + url.search + url.hash);
    return fromUrl;
  }
  return read(TOKEN_KEY);
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
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* see above */ }
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
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api/${path}`, {
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
    throw new ApiError(message, res.status);
  }
  return body as T;
}

function safeParse(text: string): unknown {
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

const post = <T,>(path: string, body: unknown): Promise<T> =>
  request<T>(path, { method: 'POST', body: JSON.stringify(body) });

const get = <T,>(path: string): Promise<T> => request<T>(path, { method: 'GET' });

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
  /**
   * Settle this session's open tasks as part of accepting the message.
   *
   * Sent as a field rather than left for the server to recognise in the
   * message text. The wording is written for the model to read, and prose
   * written to be read is prose that will be reworded — matching on it would
   * put a silent dependency on two sentences staying identical for ever.
   */
  retireTasks?: 'done' | 'cancelled';
}

export const api = {
  sessions: () => request<{
    sessions: SessionSummary[]; active: string[]; projects: Project[]; groups: Group[];
  }>('sessions'),

  // ── projects ───────────────────────────────────────────────────────
  projects: () => request<{ projects: Project[]; launch: string }>('projects'),

  addProject: (path: string, name?: string) =>
    post<{ project: Project }>('projects/add', { path, name }),

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

  session: (id: string) => request<{
    sessionId: string;
    seq: number;
    busy: boolean;
    messages: Array<{ role: string; content: string }>;
    usage: Record<string, number>;
  }>(`session?id=${encodeURIComponent(id)}`),

  submit: (opts: SubmitOptions) => post<{ accepted: boolean }>('submit', opts),
  cancel: (sessionId: string) => post<{ cancelled: boolean }>('cancel', { sessionId }),
  steer: (sessionId: string, content: string) => post<{ ok: boolean }>('steer', { sessionId, content }),
  /** Resolve the question a blocked turn is waiting on. */
  answer: (sessionId: string, content: string) => post<{ ok: boolean }>('answer', { sessionId, content }),

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

  createSkill: (name: string, description: string, body: string) =>
    post<{ ok: boolean; name?: string; error?: string }>('skills/create', { name, description, body }),
  removeSkill: (name: string) =>
    post<{ ok: boolean; error?: string }>('skills/remove', { name }),

  // ── mcp ────────────────────────────────────────────────────────────
  addMcpServer: (config: Record<string, unknown>) =>
    post<{ ok: boolean; result?: string; error?: string }>('mcp/add', config),
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
  manage: (registry: 'skills' | 'agents' | 'mcp' | 'memory', input: Record<string, unknown>) =>
    post<ManageResult>('manage', { registry, ...input }),
  memories: (scope?: string) =>
    get<{ memories: MemorySummary[] }>(`memory${scope && scope !== 'all' ? `?scope=${encodeURIComponent(scope)}` : ''}`),

  changes: (sessionId: string) => get<ChangesReport>(`changes?id=${encodeURIComponent(sessionId)}`),
  changesDiff: (sessionId: string, file: string) =>
    get<{ diff: string }>(`changes/diff?id=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(file)}`),
  /** Destructive. `deleteUntracked` is required for a file that was never committed. */
  revert: (sessionId: string, file: string, deleteUntracked = false) =>
    post<{ ok: boolean; deleted?: boolean; error?: string }>(
      'changes/revert', { sessionId, path: file, deleteUntracked }),
  followup: (sessionId: string, content: string) => post<{ ok: boolean }>('followup', { sessionId, content }),

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
  fork: (sessionId: string) =>
    post<{ id: string; title?: string; project?: string }>('session/fork', { sessionId }),

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
      provider?: string; defaultModel?: string | null; error?: string;
    }>('providers/models', id ? { id } : {}),

  /** Test an instance that already exists, by id. */
  testProvider: (id: string) => post<ProviderTestResult>('providers/test', { id }),

  /** Test what is being typed, before it is saved. */
  testProviderDraft: (draft: { type: string; apiKey?: string; baseUrl?: string }) =>
    post<ProviderTestResult>('providers/test', draft),

  settings: () => request<Record<string, unknown>>('settings'),
  saveSettings: (patch: Record<string, unknown>) => post<Record<string, unknown>>('settings', patch),

  system: () => request<SystemSnapshot>('system'),
  cancelBackgroundAgent: (agentId: string) => post<{ cancelled: boolean }>('background/cancel', { agentId }),
  cronAction: (action: 'delete' | 'pause' | 'resume', jobId: string) =>
    post<Record<string, unknown>>(`cron/${action}`, { jobId }),
};

export interface ProviderTestResult {
  ok: boolean;
  error?: string;
  models?: string[];
  latencyMs?: number;
}

/** One configured provider, as the server reports it — never with a key. */
export interface ProviderInstance {
  id: string;
  type: 'openrouter' | 'deepseek' | 'anthropic' | 'openai' | 'gemini' | 'zai' | 'ollama' | 'openai-compatible';
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
  /** False once the directory has been deleted or renamed underneath us. */
  exists: boolean;
  sessions: number;
  updatedAt: number;
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
  cron: Array<{ id: string; schedule: string; prompt?: string; task?: string; paused?: boolean; nextRun?: number }>;
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
}

// ── the event stream ─────────────────────────────────────────────────

export interface StreamEvent {
  type: string;
  sessionId: string;
  seq?: number;
  data: Record<string, unknown>;
}

export interface StreamHandle {
  close: () => void;
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
      const res = await fetch(
        `/api/events?session=${encodeURIComponent(sessionId)}&since=${since}`
        + `&token=${encodeURIComponent(getToken())}`
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
