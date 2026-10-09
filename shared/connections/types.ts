/**
 * Connections' wire contract: what every client draws of a connection to a team's
 * forge and tracker, and what the engine's provider adapters normalise to (ADR 0039).
 *
 * Lives in `shared/` because the web, desktop and VS Code clients import it and the
 * engine's adapters produce it; `src/connections/types.ts` re-exports this file
 * instead of copying it. Types and a few pure constants only; no imports, so a
 * client can use it without pulling the engine in.
 *
 * Nothing here carries a secret. A connection names its credential by vault
 * reference inside the engine and clients never see even that name: they see
 * `hasCredential`. Deliberately not here: the adapter interface (engine-only,
 * `src/connections/adapter.ts`) and the polling/rate-limit state.
 *
 * @module shared/connections/types
 */

export type ProviderId =
  | 'github' | 'gitlab' | 'azure-devops' | 'bitbucket-cloud' | 'bitbucket-dc'
  | 'gitea' | 'forgejo' | 'gitbucket' | 'custom';

/** How the page and the agent describe a provider. `supported` is false until its adapter exists. */
export interface ProviderInfo {
  id: ProviderId;
  label: string;
  /** Pre-filled for the cloud product; absent for self-hosted-only providers. */
  cloudUrl?: string;
  /** The page asks for a base URL (self-hosted, or an enterprise server flavour). */
  asksUrl: boolean;
  supported: boolean;
  /** Shown while unsupported: where it sits in the owner's order. */
  note?: string;
  /** Least-privilege token advice, shown next to the paste box. */
  tokenAdvice: string[];
  /** Where a person creates a token; a plain link, never filled with anything. */
  tokenHelpUrl?: string;
}

/** What a provider's API lets this connection do, probed, never assumed. */
export interface Capabilities {
  repos: boolean;
  pulls: { create: boolean; comment: boolean; merge: boolean; draft: boolean; bodyMax: number };
  items: { query: boolean; create: boolean; transition: boolean; comment: boolean; estimate: 'field' | 'label' | 'none'; parentLink: boolean };
  iterations: 'native' | 'milestone' | 'none';
  checks: { read: boolean; rerun: boolean; logsUrl: boolean };
  protection: { read: boolean };
}

export interface ScopeAdvice {
  scope: string;
  /** What breaks without it, in plain words. */
  why: string;
  /** The capability chip it unlocks. */
  feature: 'repos' | 'pulls' | 'items' | 'checks' | 'iterations' | 'protection';
  /** Needed for the page to call the connection usable at all. */
  required: boolean;
}

export interface ProbeResult {
  at: string;
  /** The account the token acts as (login), shown so a person can check it is the right one. */
  user: string;
  version?: string;
  capabilities: Capabilities;
  scopes: {
    /** Scopes the provider reported for the token (may be empty when it does not say). */
    found: string[];
    needed: ScopeAdvice[];
    /** Names of `needed` scopes that are not among `found` (only when the provider reports scopes). */
    missing: string[];
    /** Powers beyond least privilege that were detected, shown as a warning. */
    extra: string[];
    /** The provider does not report token scopes (fine-grained tokens); capabilities are probed by calls instead. */
    reported: boolean;
  };
  /** Plain-language problems that do not stop use ("protection unreadable", "no Projects v2"). */
  warnings: string[];
  tokenExpiresAt?: string;
}

export type ConnectionState = 'connected' | 'needs-attention' | 'off';

export interface Connection {
  id: string;
  provider: ProviderId;
  label: string;
  /** `https://…`; `http://` only for a private or loopback address a person opted into. */
  baseUrl: string;
  host: string;
  /** Every host this connection may contact (the base host, plus the API host for cloud SKUs). */
  hosts: string[];
  /** A person opted into plain http for this private address. */
  insecureHttp?: boolean;
  /** Path of a PEM CA bundle applied only to this connection's requests (and its git child). */
  caBundle?: string;
  disabled?: boolean;
  createdAt: string;
  createdBy: 'person' | 'agent';
  /** The connection exists but nobody has stored a token for it yet. */
  hasCredential: boolean;
  state: ConnectionState;
  /** One sentence that says why the state is not `connected` (Sign in again, Blocked by policy, Rate-limited …). */
  stateDetail?: string;
  probe?: ProbeResult;
  /** The engine's polling sees the provider's rate limit. */
  rateLimited?: { until: string };
  /** Projects mapped to this connection (absolute paths). */
  projects: string[];
}

export type WorkItemSource = 'off' | 'assigned-to-me' | 'label' | 'query';
export type LandingMode = 'local' | 'pr';

export interface RepoRef {
  owner: string;
  name: string;
  /** The provider's id for the repo, when it has one. */
  id?: string;
}

export interface ProjectMapping {
  project: string;
  connection: string;
  repo: RepoRef;
  workItems: { source: WorkItemSource; value?: string };
  landing: LandingMode;
  trunk: string;
  iterations: 'off' | 'native';
  /** Local task state -> remote state name/label (the page shows seven rows). */
  stateMap: Record<string, string>;
  /** Authors whose PR comments may reach the agent, beyond members and collaborators. */
  trustedCommenters?: string[];
}

/** What the page shows for a project's repo before a mapping exists. */
export interface RepoDetection {
  project: string;
  /** `git remote get-url origin`, with any userinfo removed. */
  origin?: string;
  provider?: ProviderId;
  repo?: RepoRef;
  /** An existing connection whose host matches the origin. */
  connection?: string;
  /** The trunk branch name the project uses. */
  trunk?: string;
}

/** Why the sync indicator in the board header says what it says. */
export interface SyncStatus {
  state: 'idle' | 'syncing' | 'rate-limited' | 'error' | 'blocked';
  at?: string;
  message?: string;
}

/** The board header's view of a project's connection. */
export interface BoardConnection {
  connection: string;
  label: string;
  provider: ProviderId;
  repo: string;
  landing: LandingMode;
  workItems: ProjectMapping['workItems']['source'];
  sync: SyncStatus;
}

// ── normalised remote objects (what every adapter produces) ─────────────

export type CheckState = 'none' | 'pending' | 'passing' | 'failing';
export type ReviewState = 'none' | 'pending' | 'approved' | 'changes';

export interface RemoteCheck {
  name: string;
  state: 'pending' | 'success' | 'failure' | 'neutral' | 'skipped';
  url?: string;
  /** Short, already sanitised, untrusted text from the check (never shown to the agent as instructions). */
  summary?: string;
}

/** The remote's view of a task's pull request, folded onto `Task.pr`. */
export interface PullState {
  connection: string;
  /** The provider's number/id for the PR (a string so Azure's ids and GitHub's numbers share a type). */
  id: string;
  url: string;
  state: 'open' | 'merged' | 'closed';
  draft: boolean;
  headSha: string;
  mergeable: 'mergeable' | 'conflicting' | 'unknown';
  checks: { state: CheckState; items: RemoteCheck[] };
  reviews: { state: ReviewState; approved: number; required?: number; changesRequested: number };
  /** The remote reports the PR can be merged now and the requirements are satisfied. */
  canMerge: boolean;
  /** Why not, in the remote's own terms ("2 required checks have not passed"). */
  mergeBlockers: string[];
  /** The target branch is protected on the remote (when readable). */
  protectedBase?: boolean;
  /** SHA of the merge commit once merged. */
  mergedSha?: string;
  observedAt: string;
}

/** The remote work item a task was imported from or linked to. */
export interface RemoteLink {
  connection: string;
  kind: 'item';
  /** The provider's id (GitHub issue number as a string). */
  id: string;
  url: string;
  /** The revision pulled last (`updated_at`); a write carries it back. */
  rev: string;
  syncedAt: string;
  /** Open or closed on the remote at the last pull. */
  remoteState: 'open' | 'closed';
  /** The remote shows it as ready/committed but nobody here promoted it (the card offers one click). */
  readyOnRemote?: boolean;
}

// ── route bodies (the page's requests; all JSON) ─────────────────────────

/**
 * Routes, for clients (`/api/connections/...`). Gate in brackets: [token] token only,
 * [person] a person in the AICO window (the API token alone cannot do it).
 *
 *   GET   providers                         ProviderInfo[]
 *   GET   list                              { connections: Connection[]; policy: ConnectionsPolicyView }
 *   POST  create    {provider,label?,baseUrl?,insecureHttp?,caBundle?}  [person]   -> Connection (no credential yet)
 *   POST  credential {id, token}           [person]   token travels in only; stored in the vault bound to the host; -> Connection
 *   POST  test      {id}                   [token]    runs the capability probe -> Connection (with probe)
 *   POST  update    {id, label?, disabled?}  [person]  baseUrl and hosts cannot change after the first credential
 *   POST  remove    {id}                   [person]   removes the connection and its vault credential
 *   GET   detect?project=                  RepoDetection
 *   GET   mapping?project=                 { mapping?: ProjectMapping; connection?: BoardConnection }
 *   POST  map       {project, connection, repo?, workItems?, landing?, trunk?, stateMap?}  [person; landing:'pr' is a confirm card the person accepts]
 *   POST  unmap     {project}              [person]
 *   POST  sync      {project}              [token]    pull items + observe PRs now -> { imported, updated, pushed, observed, conflicts }
 */
export interface ConnectionsPolicyView {
  mode: 'any' | 'forbid' | 'allow-list';
  providers?: string[];
  hosts?: string[];
  maxLanding?: LandingMode;
  /** Short plain statement for the page when anything restricts connections. */
  message?: string;
}

export const PROVIDERS: readonly ProviderInfo[] = [
  {
    id: 'github', label: 'GitHub', cloudUrl: 'https://github.com', asksUrl: false, supported: true,
    tokenAdvice: [
      'Repository access: only the repositories you map',
      'Contents: read and write (to push aico/task-* branches)',
      'Pull requests: read and write',
      'Issues: read and write',
      'Commit statuses and Checks: read',
      'Metadata: read',
    ],
    tokenHelpUrl: 'https://github.com/settings/personal-access-tokens/new',
  },
  {
    id: 'azure-devops', label: 'Azure DevOps', asksUrl: true, supported: false, note: 'Next after GitHub.',
    tokenAdvice: ['Code: read and write', 'Work Items: read and write', 'Build: read'],
  },
  { id: 'gitlab', label: 'GitLab', cloudUrl: 'https://gitlab.com', asksUrl: false, supported: false, note: 'After Azure DevOps.', tokenAdvice: ['api (or a project access token with the Developer role)'] },
  { id: 'gitea', label: 'Gitea', asksUrl: true, supported: false, note: 'After Azure DevOps.', tokenAdvice: ['repository and issue read/write'] },
  { id: 'forgejo', label: 'Forgejo', asksUrl: true, supported: false, note: 'After Azure DevOps.', tokenAdvice: ['repository and issue read/write'] },
  { id: 'gitbucket', label: 'GitBucket', asksUrl: true, supported: false, note: 'After Azure DevOps.', tokenAdvice: ['repo'] },
  { id: 'bitbucket-cloud', label: 'Bitbucket Cloud', cloudUrl: 'https://bitbucket.org', asksUrl: false, supported: false, note: 'After the others.', tokenAdvice: ['pull requests and repositories: read and write'] },
  { id: 'bitbucket-dc', label: 'Bitbucket Data Center', asksUrl: true, supported: false, note: 'After the others.', tokenAdvice: ['project and repository: write'] },
];

/** A connection id is a slug: letters, digits, `-`, `_`. */
export const CONNECTION_ID_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;

/** The default state-name map shown as seven rows (ADR 0039 §2). */
export const DEFAULT_STATE_MAP: Readonly<Record<string, string>> = Object.freeze({
  backlog: 'open', ready: 'open', running: 'aico:running', review: 'aico:in-review', pr: 'aico:pr-open', merged: 'closed', blocked: 'aico:blocked',
});
