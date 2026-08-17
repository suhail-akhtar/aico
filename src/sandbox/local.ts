/**
 * The in-process sandbox backend.
 *
 * Confines AICO's own file tools, and is honest that it cannot confine anything
 * else.
 *
 * ## What it enforces, and what it does not
 *
 * | Surface | Enforcement | Why |
 * |---|---|---|
 * | `Read`, `Write`, `Edit`, `Glob`, `Grep` | `full` | AICO resolves every path itself before touching the filesystem, so every effect passes through this check |
 * | `Bash` and anything it spawns | `partial` | Confining a child process needs an OS mechanism — Landlock, Seatbelt, or a Windows restricted token — and this backend has none |
 *
 * Reporting `full` for the second row would be the exact failure
 * {@link SandboxEnforcement} exists to prevent, so it reports `partial` and
 * carries the reason. A caller that needs an absolute boundary can then refuse
 * rather than proceeding on a promise nothing keeps.
 *
 * This is defence in depth, not a jail. It stops an agent from writing outside
 * the workspace by mistake or by a confused instruction. It does not stop
 * deliberate evasion through a shell.
 *
 * @module sandbox/local
 */

import { canonicalize, isWithin, temporaryRoot } from './path-policy.js';
import type {
  SandboxAccess,
  SandboxCapability,
  SandboxDecision,
  SandboxPolicy,
} from './types.js';

/** Reason attached to every subprocess decision on this backend. */
export const SUBPROCESS_PARTIAL_REASON =
  'this backend confines AICO\'s own file tools only; a spawned process can ' +
  'still write anywhere the user can. Full subprocess confinement needs an OS ' +
  'mechanism (Linux Landlock, macOS Seatbelt, or a Windows restricted token).';

/** In-process path confinement for AICO's file tools. */
export class LocalSandbox implements SandboxCapability {
  readonly id = 'local-inprocess';

  check(target: string, access: SandboxAccess, policy: SandboxPolicy): SandboxDecision {
    if (policy.mode === 'danger-full-access') {
      return { allowed: true, enforcement: 'full', reason: 'confinement bypassed by policy' };
    }

    let resolved: string;
    try {
      resolved = canonicalize(target);
    } catch (err) {
      // A path that cannot even be canonicalized is refused rather than passed
      // through: an un-analysable path is precisely the one not to allow.
      return {
        allowed: false,
        enforcement: 'full',
        reason: `path could not be resolved: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // Reads are unrestricted in both confining modes. The policy governs file
    // EFFECTS; a read-only agent that cannot read is not a useful one, and
    // restricting reads is a different concern (secrets) handled by the bash
    // safety classifier.
    if (access === 'read') {
      return { allowed: true, enforcement: 'full', resolvedPath: resolved };
    }

    if (policy.mode === 'read-only') {
      return {
        allowed: false,
        enforcement: 'full',
        resolvedPath: resolved,
        reason: 'sandbox mode is read-only; writes are not permitted',
      };
    }

    // workspace-write
    const roots = [policy.workspaceRoot, ...(policy.additionalWritableRoots ?? []), temporaryRoot()];
    for (const root of roots) {
      let canonicalRoot: string;
      try {
        canonicalRoot = canonicalize(root);
      } catch {
        continue;
      }
      if (isWithin(resolved, canonicalRoot)) {
        return { allowed: true, enforcement: 'full', resolvedPath: resolved };
      }
    }

    return {
      allowed: false,
      enforcement: 'full',
      resolvedPath: resolved,
      reason:
        `writes are confined to the workspace (${policy.workspaceRoot}) and the ` +
        `temp directory; "${resolved}" is outside both`,
    };
  }

  describeSubprocessEnforcement(policy: SandboxPolicy): SandboxDecision {
    if (policy.mode === 'danger-full-access') {
      return { allowed: true, enforcement: 'full', reason: 'confinement bypassed by policy' };
    }
    // Honest by construction: the command is permitted to run, and the caller
    // is told the confinement it might have assumed is not in force.
    return { allowed: true, enforcement: 'partial', reason: SUBPROCESS_PARTIAL_REASON };
  }
}

/** Build a policy from settings and the session's working directory. */
export function resolveSandboxPolicy(
  mode: SandboxPolicy['mode'],
  workspaceRoot: string,
  additionalWritableRoots?: string[],
): SandboxPolicy {
  let root: string;
  try {
    root = canonicalize(workspaceRoot);
  } catch {
    root = workspaceRoot;
  }
  return {
    mode,
    workspaceRoot: root,
    ...(additionalWritableRoots ? { additionalWritableRoots } : {}),
  };
}
