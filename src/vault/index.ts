/**
 * The credential vault's public face: what other parts of AICO build on.
 *
 * Consumers — an SSH tool, an HTTP tool, WinRM, SNMP, the desktop browser's
 * vault login, the Credential Manager — use the functions below and nothing
 * deeper. The contract, in one paragraph:
 *
 *   The model gives you a *name*. You call {@link resolve} with that name and
 *   an honest description of the use (your tool's name, the host or origin
 *   you are about to send the value to, why). You get the fields back only if
 *   the credential's policy allows exactly that use — and after a person
 *   approved it, when the policy asks for that. You send the value to that
 *   host, call `release()`, and return to the model a result that does not
 *   contain it. Everything you return is redacted anyway; do not rely on that.
 *
 * There is intentionally no export here that returns values without a policy
 * check or a human grant. See docs/security/credential-broker.md, "How to
 * write a secret-consuming tool".
 *
 * @module vault
 */

import { VaultService, type VaultServiceOptions } from './service.js';
import { activeRedactor, sinkRedact, sinkRedactAccumulated, sinkRedactText, sinkStream } from './sink.js';
import type { ApprovalPrompter, HumanRequester } from './human.js';
import type { CredentialKind, CredentialSummary, UseContext } from './types.js';

let instance: VaultService | undefined;

/** The process's vault. Created on first use under `<AICO_HOME>/vault`. */
export function getVault(): VaultService {
  instance ??= new VaultService();
  return instance;
}

/**
 * Replace the process's vault (tests, or a host that needs a specific key
 * provider). The previous instance is locked first.
 */
export function configureVault(options: VaultServiceOptions): VaultService {
  if (instance?.store.isUnlocked()) instance.store.lock();
  instance = new VaultService(options);
  return instance;
}

/** Whether a vault exists or has been opened in this process. Cheap. */
export function vaultInUse(): boolean {
  return instance !== undefined && (instance.store.isUnlocked() || instance.store.exists());
}

// ── consumer API ─────────────────────────────────────────────────────

/**
 * Resolve a credential for one use. See the module doc for the contract.
 *
 * @throws CredentialNotFoundError (with similar names), PolicyDeniedError,
 *   ApprovalDeniedError, VaultLockedError. None of them carries a value.
 */
export function resolve(ref: string, use: UseContext, fallbackPrompter?: ApprovalPrompter) {
  return getVault().resolve(ref, use, fallbackPrompter);
}

/** Metadata and policy of every credential (optionally filtered). Never values. */
export function list(filter: { host?: string; kind?: CredentialKind; tag?: string } = {}): Promise<CredentialSummary[]> {
  return getVault().list(filter);
}

/** Credentials bound to a web origin — what a browser may offer to log in with. */
export function findForOrigin(origin: string): Promise<CredentialSummary[]> {
  return getVault().findForOrigin(origin);
}

/** Store a credential. Write-only: the secret is never echoed. */
export function create(...args: Parameters<VaultService['create']>) {
  return getVault().create(...args);
}

/** Create a random credential bound to a scope. Returns only the non-secret parts. */
export function generate(...args: Parameters<VaultService['generate']>) {
  return getVault().generate(...args);
}

/** Ask a person to enter a credential; resolves to stored / declined / timeout / unavailable. */
export function requestFromHuman(...args: Parameters<VaultService['requestFromHuman']>) {
  return getVault().requestFromHuman(...args);
}

/** Set who approves uses, process-wide (the server and desktop do). */
export function setApprovalPrompter(prompter: ApprovalPrompter | undefined): void {
  getVault().setApprovalPrompter(prompter);
}

/** Set who is asked to type credentials in, process-wide. */
export function setHumanRequester(requester: HumanRequester | undefined): void {
  getVault().setHumanRequester(requester);
}

/** The redactor in force (a snapshot; it is replaced whenever the vault changes). */
export function redactor() {
  return activeRedactor();
}

/** Redact a value/string/accumulated text/stream with the redactor in force. */
export const redact = {
  value: sinkRedact,
  text: sinkRedactText,
  accumulated: sinkRedactAccumulated,
  stream: sinkStream,
};

// ── types and errors consumers need ──────────────────────────────────

export type { ResolvedSecret, GenerateInput, GenerateResult, HumanRequestOutcome, QuarantineResult, VaultNotifier, HostOutbound } from './service.js';
export type { ApprovalPrompter, ApprovalRequest, HumanRequester, HumanCredentialRequest, HumanCredentialResponse, GrantAction } from './human.js';
export { denyPrompter, ttyPrompter, callbackPrompter, ttyRequester } from './human.js';
export type {
  CredentialKind, CredentialMeta, CredentialSummary, Policy, UseContext, ApprovalMode, PublicParts, CreatedBy,
} from './types.js';
export {
  VaultError, VaultLockedError, VaultUnavailableError, CredentialNotFoundError, PolicyDeniedError,
  ApprovalDeniedError, GrantRequiredError, VaultTamperedError, CREDENTIAL_KINDS, SECRET_FIELDS,
} from './types.js';
export { parsePlaceholders, hasPlaceholders, referenceFor, PLACEHOLDER_RE } from './placeholders.js';
export { VaultService } from './service.js';
