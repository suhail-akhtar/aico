/**
 * Process sandbox — file-effect confinement with honest enforcement reporting.
 *
 * Confinement governs *effects*, not reads: writes are held inside the
 * workspace while reads stay unrestricted, because a coding agent that cannot
 * read its surroundings is useless and a read cannot corrupt them.
 *
 * Enforcement is reported as `full` or `partial` rather than asserted. File
 * tools are fully confined; subprocesses are not, because a shell can reach
 * past any check this layer makes. Saying so is the point — a sandbox that
 * overstates its reach is worse than one that admits its edge, since only the
 * first kind gets trusted with something it cannot actually hold.
 *
 * @module sandbox
 */

export type {
  ConfinedSandboxMode,
  SandboxAccess,
  SandboxCapability,
  SandboxDecision,
  SandboxEnforcement,
  SandboxMode,
  SandboxPolicy,
} from './types.js';

export { canonicalize, isWithin, temporaryRoot } from './path-policy.js';
export { LocalSandbox, SUBPROCESS_PARTIAL_REASON, resolveSandboxPolicy } from './local.js';
export type { SandboxGuardOptions } from './guard.js';
export { installSandboxGuard } from './guard.js';

declare module '../registry/context.js' {
  interface Capabilities {
    /** File-effect confinement. See {@link SandboxCapability}. */
    sandbox: import('./types.js').SandboxCapability;
  }
}
