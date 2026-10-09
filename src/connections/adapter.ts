/**
 * The provider adapter interface (ADR 0039 section 1): what Delivery and the Connections page
 * need from a forge, in normalised shapes, with every optional member a probed capability.
 *
 * An adapter is a thin translator. It owns the provider's URLs, JSON shapes, auth scheme and
 * quirks, and returns the normalised types from `shared/connections/types.ts`. It does NOT own:
 *
 *  - the transport (`ConnectionClient`: policy, SSRF guard, TLS, rate limits, audit of writes);
 *  - the credential (the client resolves it from the vault; an adapter never sees the value);
 *  - any decision about what to sync, push or merge (`sync.ts`, `landing.ts`);
 *  - remote text hygiene beyond calling `sanitizeRemoteText` on what it returns (every string
 *    that a stranger could have written is sanitised on the way out of the adapter).
 *
 * No vendor SDK: fetch-shaped calls through the client, GraphQL as a plain POST. Adding a
 * provider means implementing this interface and passing the conformance suite
 * (`scripts/connections-conformance.mjs`) against recorded fixtures; nothing else changes.
 *
 * @module connections/adapter
 */

import type { Capabilities, ProbeResult, ProviderId, PullState, RemoteCheck, RepoRef, WorkItemSource } from '../../shared/connections/types.js';
import type { ConnectionClient } from './http.js';
import type { StoredConnection } from './types.js';

export interface AdapterCtx {
  conn: StoredConnection;
  client: ConnectionClient;
  /** Set once a project is mapped; calls that need a repository read it from here. */
  repo?: RepoRef;
  signal?: AbortSignal;
  /** The project path, for audit lines. */
  project?: string;
}

export interface RepoInfo {
  ref: RepoRef;
  defaultBranch: string;
  /** `https://host/owner/name.git`, no userinfo. */
  cloneUrl: string;
  htmlUrl: string;
  private: boolean;
  /** What the token may do here, when the provider says. */
  permissions?: { pull: boolean; push: boolean; admin: boolean };
}

export interface NewPull {
  /** The source branch (`aico/task-<id>`), on the same repository. */
  head: string;
  base: string;
  title: string;
  /** Markdown; the adapter clips it to `Capabilities.pulls.bodyMax` and returns the overflow. */
  body: string;
  draft?: boolean;
}

export interface Comment {
  id: string;
  author: string;
  /** The provider's relationship of the author to the repository: OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, NONE ... */
  association: string;
  body: string;
  at: string;
  /** A review (not a plain comment): its state. */
  review?: 'approved' | 'changes' | 'commented';
  url?: string;
}

export interface RemoteItem {
  id: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  assignees: string[];
  author: string;
  url: string;
  /** `updated_at`, the revision a write carries back. */
  rev: string;
  milestone?: { id: string; title: string; dueOn?: string };
  /** Story points, when a field/label convention yields one. */
  points?: number;
}

export interface ItemQuery {
  source: WorkItemSource;
  /** The label, or the provider's query text. */
  value?: string;
  /** Only items updated at or after this ISO time. */
  since?: string;
  /** The login the token acts as (for `assigned-to-me`). */
  me?: string;
  state?: 'open' | 'closed' | 'all';
}

export interface Iteration {
  id: string;
  title: string;
  kind: 'milestone' | 'iteration';
  start?: string;
  end?: string;
  state: 'open' | 'closed';
  url?: string;
  openItems?: number;
  closedItems?: number;
}

export interface ProtectionInfo {
  /** The base branch is protected on the remote. */
  protected: boolean;
  requiredReviews?: number;
  requiredChecks?: string[];
  /** Why this is unknown, when the token cannot read it. */
  unreadable?: string;
}

export interface ProviderAdapter {
  readonly id: ProviderId;

  /** Where the REST API lives for this connection's base URL. */
  apiBase(conn: StoredConnection): string;
  /** Hosts a connection to `baseUrl` may contact (the API host and the clone host). */
  hostsFor(baseUrl: string): string[];
  /** How the client should authenticate. */
  clientOptions(conn: StoredConnection): Pick<import('./http.js').ClientOptions, 'apiBase' | 'auth' | 'username' | 'headers'>;
  /** Parse an `origin` remote URL into a repository, or undefined if it is not this provider's. */
  parseRemote(url: string, baseUrl: string): RepoRef | undefined;

  /** Runs at Test time and on version change: reads who the token is, its scopes, and one cheap call per optional capability. */
  probe(ctx: AdapterCtx): Promise<ProbeResult>;

  repos: {
    get(ctx: AdapterCtx, ref: RepoRef): Promise<RepoInfo>;
    list(ctx: AdapterCtx, query?: string): Promise<RepoInfo[]>;
  };

  pulls?: {
    /** An open PR whose head is this branch, if any (makes opening idempotent). */
    find(ctx: AdapterCtx, head: string): Promise<PullState | undefined>;
    create(ctx: AdapterCtx, input: NewPull): Promise<{ pull: PullState; overflow?: string }>;
    update(ctx: AdapterCtx, id: string, patch: { title?: string; body?: string; state?: 'open' | 'closed' }): Promise<PullState>;
    comment(ctx: AdapterCtx, id: string, markdown: string): Promise<void>;
    /** Full state: draft, mergeable, reviews, required, checks, canMerge and why not. */
    get(ctx: AdapterCtx, id: string): Promise<PullState>;
    /** Conversation comments and reviews, newest last, each with the author's association. */
    comments(ctx: AdapterCtx, id: string): Promise<Comment[]>;
    /** Merge. Only called by a person's click and only when `PullState.canMerge`; never an admin bypass. */
    merge?(ctx: AdapterCtx, id: string, opts: { method: 'merge' | 'squash' | 'rebase'; sha: string }): Promise<{ sha: string }>;
  };

  items?: {
    query(ctx: AdapterCtx, q: ItemQuery): Promise<{ items: RemoteItem[]; notModified: boolean }>;
    get(ctx: AdapterCtx, id: string): Promise<RemoteItem>;
    create(ctx: AdapterCtx, input: { title: string; body: string; labels?: string[] }): Promise<RemoteItem>;
    /** `ifRev`: the `rev` this change is based on; a mismatch is a ConnectionError('conflict'). */
    update(ctx: AdapterCtx, id: string, patch: { title?: string; body?: string; labels?: string[]; milestone?: string | null }, ifRev: string): Promise<RemoteItem>;
    transition(ctx: AdapterCtx, id: string, to: 'open' | 'closed', ifRev: string): Promise<RemoteItem>;
    comment(ctx: AdapterCtx, id: string, markdown: string): Promise<void>;
    addLabels(ctx: AdapterCtx, id: string, labels: string[]): Promise<void>;
    removeLabel(ctx: AdapterCtx, id: string, label: string): Promise<void>;
  };

  iterations?: {
    list(ctx: AdapterCtx): Promise<Iteration[]>;
    assign?(ctx: AdapterCtx, itemId: string, iterationId: string): Promise<void>;
    create?(ctx: AdapterCtx, input: { title: string; start?: string; end?: string }): Promise<Iteration>;
  };

  checks?: {
    forCommit(ctx: AdapterCtx, sha: string): Promise<RemoteCheck[]>;
    rerun?(ctx: AdapterCtx, checkId: string): Promise<void>;
  };

  protection?: {
    read(ctx: AdapterCtx, branch: string): Promise<ProtectionInfo>;
  };
}

/** `Capabilities` with everything off: the starting point a probe fills in. */
export function noCapabilities(): Capabilities {
  return {
    repos: false,
    pulls: { create: false, comment: false, merge: false, draft: false, bodyMax: 4000 },
    items: { query: false, create: false, transition: false, comment: false, estimate: 'none', parentLink: false },
    iterations: 'none',
    checks: { read: false, rerun: false, logsUrl: false },
    protection: { read: false },
  };
}
