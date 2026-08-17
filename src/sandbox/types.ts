/**
 * Sandbox vocabulary.
 *
 * ## Enforcement is a reported fact, not an assumption
 *
 * The single most important idea here is that a backend must say how much of
 * the promised policy it actually governs. A sandbox that silently enforces
 * half of what it claims is worse than no sandbox: callers stop checking.
 *
 * So {@link SandboxEnforcement} is part of every decision, and a consumer that
 * needs an absolute boundary must reject `partial` rather than treating it as
 * `full`.
 *
 * On this platform that distinction is not hypothetical:
 *
 *   • **In-process file tools** (`Read`, `Write`, `Edit`, `Glob`, `Grep`) can be
 *     confined completely, because AICO resolves every path itself before
 *     touching the filesystem. Reported `full`.
 *   • **Spawned processes** (`Bash`) cannot. Confining a child process on
 *     Windows needs an ACL restricted token or a job object; without one, a
 *     command is free to write wherever the user can. Reported `partial`, and
 *     the reason is carried with it.
 *
 * Linux Landlock and macOS Seatbelt would report `full` for subprocesses too.
 * Those backends are not implemented here, and claiming otherwise would be the
 * exact failure this type exists to prevent.
 *
 * @module sandbox/types
 */

/**
 * File-effect policy.
 *
 * Governs file effects only. Network access and process visibility are outside
 * this vocabulary — saying "sandboxed" while a confined command can still make
 * arbitrary network calls would overstate what is enforced.
 */
export type SandboxMode =
  /** No writes. Reads are unrestricted. */
  | 'read-only'
  /** Writes permitted under the workspace root and the temp area. */
  | 'workspace-write'
  /** No confinement at all. */
  | 'danger-full-access';

/** The modes that actually confine something. */
export type ConfinedSandboxMode = Exclude<SandboxMode, 'danger-full-access'>;

/**
 * How completely the backend governs the promised policy.
 *
 * `partial` means an active backend cannot govern every effect the mode
 * promises. Callers requiring an absolute boundary must not treat it as `full`.
 */
export type SandboxEnforcement = 'full' | 'partial';

/** Policy resolved for one operation. */
export interface SandboxPolicy {
  mode: SandboxMode;
  /**
   * Canonical root writes are confined to under `workspace-write`.
   *
   * Canonicalized with filesystem semantics (symlinks and Windows junctions
   * resolved) before comparison, so a root reached through a link identifies
   * the directory writes actually land in.
   */
  workspaceRoot: string;
  /** Additional roots that may be written to (temp areas, caches). */
  additionalWritableRoots?: string[];
}

/** The verdict on one path. */
export interface SandboxDecision {
  allowed: boolean;
  /** How completely this decision was enforced. */
  enforcement: SandboxEnforcement;
  /** Why it was refused, or why enforcement is partial. */
  reason?: string;
  /** The canonical path the decision was made about. */
  resolvedPath?: string;
}

/** The kind of access being requested. */
export type SandboxAccess = 'read' | 'write';

/**
 * The process-sandbox seam.
 *
 * Consumers ask for a decision and honour it; they never learn which backend
 * answered, which is what lets a container, a microVM, or a remote executor be
 * substituted later without touching a single call site.
 */
export interface SandboxCapability {
  /** Backend identity, for diagnostics. */
  readonly id: string;
  /** Whether a path may be accessed under this policy. */
  check(path: string, access: SandboxAccess, policy: SandboxPolicy): SandboxDecision;
  /**
   * How completely this backend can confine a spawned process.
   *
   * Separate from {@link check} because the answer genuinely differs: this
   * backend governs its own file tools completely and spawned processes not at
   * all, and collapsing the two would misreport one of them.
   */
  describeSubprocessEnforcement(policy: SandboxPolicy): SandboxDecision;
}
