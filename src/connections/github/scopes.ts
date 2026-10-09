/**
 * What a GitHub token is advised to have, what it is missing, and what it can do that AICO
 * never needs (ADR 0039 section 6, "over-scoped token").
 *
 * WHY. GitHub tells a classic token's scopes in the `x-oauth-scopes` response header and says
 * nothing at all for a fine-grained token, so the two are different cases: with a classic
 * token missing scopes are computed by name, with a fine-grained one they are NOT (guessing
 * would show a false "missing" chip) and the capabilities come from probing instead. The
 * detection of extra power is deliberately a short, boring list of scopes whose only use is
 * administering things AICO never touches; the point is a plain warning, not a verdict.
 *
 * What it does not do: call the network, or decide whether a token is acceptable.
 *
 * @module connections/github/scopes
 */

import { PROVIDERS, type ScopeAdvice } from '../../../shared/connections/types.js';

/** `x-oauth-scopes: repo, read:user` -> ['repo', 'read:user']. Undefined when the header is absent. */
export function parseScopes(header: string | undefined): string[] | undefined {
  if (header === undefined) return undefined;
  return header.split(',').map(s => s.trim()).filter(Boolean);
}

/** Classic-token scopes that grant power AICO never needs, with what that power is. */
const EXTRA_SCOPES: ReadonlyArray<readonly [scope: string, plain: string]> = [
  ['admin:org', 'can administer organisations and teams'],
  ['admin:repo_hook', 'can create and delete repository webhooks'],
  ['admin:org_hook', 'can create and delete organisation webhooks'],
  ['admin:public_key', 'can add and remove SSH keys on the account'],
  ['admin:gpg_key', 'can add and remove GPG keys on the account'],
  ['admin:enterprise', 'can administer the enterprise'],
  ['delete_repo', 'can delete repositories'],
  ['write:packages', 'can publish packages'],
  ['delete:packages', 'can delete packages'],
  ['workflow', 'can change GitHub Actions workflow files'],
  ['site_admin', 'can administer the whole GitHub Enterprise Server'],
  ['write:org', 'can change organisation membership and settings'],
  ['user', 'can change the account profile and emails'],
];

export function extraPowers(found: string[]): string[] {
  const out: string[] = [];
  for (const [scope, plain] of EXTRA_SCOPES) if (found.includes(scope)) out.push(`${scope}: ${plain}`);
  if (found.includes('repo')) {
    out.push('repo: full control of every repository the account can reach (a fine-grained token limited to the mapped repository is safer)');
  }
  return out;
}

const CLASSIC_NEEDED: ScopeAdvice[] = [
  { scope: 'repo', why: 'Read and write repositories, pull requests, issues and checks (private repositories need it).', feature: 'pulls', required: true },
  { scope: 'read:user', why: 'Show which account the token acts as.', feature: 'repos', required: false },
];

/** Fine-grained tokens have permissions, not scopes; the page shows the list the provider table gives. */
function fineGrainedNeeded(): ScopeAdvice[] {
  const advice = PROVIDERS.find(p => p.id === 'github')?.tokenAdvice ?? [];
  const featureOf = (line: string): ScopeAdvice['feature'] => {
    if (/pull/i.test(line)) return 'pulls';
    if (/issue/i.test(line)) return 'items';
    if (/check|status/i.test(line)) return 'checks';
    return 'repos';
  };
  return advice.map(line => ({ scope: line, why: line, feature: featureOf(line), required: /metadata|contents|pull/i.test(line) }));
}

export function neededScopes(reported: boolean): ScopeAdvice[] {
  return reported ? CLASSIC_NEEDED : fineGrainedNeeded();
}

/** Names of `needed` scopes not among `found`. Only meaningful when scopes are reported. */
export function missingScopes(found: string[], reported: boolean): string[] {
  if (!reported) return [];
  const has = (s: string): boolean => {
    if (found.includes(s)) return true;
    // `user` includes `read:user`.
    return s === 'read:user' && found.includes('user');
  };
  return CLASSIC_NEEDED.filter(n => !has(n.scope)).map(n => n.scope);
}
