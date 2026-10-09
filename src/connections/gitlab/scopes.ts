/**
 * What a GitLab token is advised to have, what it is missing, and what it can do that AICO
 * never needs (ADR 0039 section 6, "over-scoped token").
 *
 * WHY. GitLab 15.5+ answers `GET /personal_access_tokens/self` with the token's scopes and
 * expiry (personal, project and group access tokens alike); an older server answers 404 and
 * says nothing, and that is a different case from "the token has no scopes": with nothing
 * reported the page must not show a false "missing" chip, so capabilities come from real
 * calls instead (the GitHub fine-grained case, same rule).
 *
 * The one scope AICO needs is `api`: merge requests, notes, issues and pipelines are all
 * behind it, and it also lets git push over https, so a separate `write_repository` is not
 * required. `read_api` is read-only and cannot open a merge request, so it is reported as
 * missing `api` rather than quietly accepted. The coarse scope is GitLab's, not ours, and it is the
 * one AICO needs, so it is NOT flagged as extra power (that would put a warning on every correct
 * token); the advice, shown beside the paste box, is a PROJECT access token with the Developer
 * role, which cannot push a protected branch whatever the scope says.
 *
 * What it does not do: call the network, or decide whether a token is acceptable.
 *
 * @module connections/gitlab/scopes
 */

import type { ScopeAdvice } from '../../../shared/connections/types.js';

/** Scopes that grant power AICO never needs, with what that power is. */
const EXTRA_SCOPES: ReadonlyArray<readonly [scope: string, plain: string]> = [
  ['sudo', 'can act as any user on the instance'],
  ['admin_mode', 'can use administrator-only API endpoints'],
  ['create_runner', 'can register CI runners'],
  ['manage_runner', 'can manage CI runners'],
  ['k8s_proxy', 'can reach the project\'s Kubernetes clusters'],
  ['ai_features', 'can use GitLab\'s AI features on the account\'s behalf'],
  ['read_service_ping', 'can read instance usage data'],
];

export function extraPowers(found: string[]): string[] {
  const out: string[] = [];
  for (const [scope, plain] of EXTRA_SCOPES) if (found.includes(scope)) out.push(`${scope}: ${plain}`);
  return out;
}

const NEEDED: ScopeAdvice[] = [
  { scope: 'api', why: 'Open merge requests, comment on them, import and update issues and read pipelines. Also lets git push over https.', feature: 'pulls', required: true },
  { scope: 'read_user', why: 'Show which account the token acts as.', feature: 'repos', required: false },
];

export function neededScopes(): ScopeAdvice[] { return NEEDED; }

/** Names of `needed` scopes not among `found`. Only meaningful when scopes are reported. */
export function missingScopes(found: string[], reported: boolean): string[] {
  if (!reported) return [];
  const has = (s: string): boolean => found.includes(s) || (s === 'read_user' && found.includes('api'));
  return NEEDED.filter(n => !has(n.scope)).map(n => n.scope);
}

/** `['api']` from `{"scopes":["api"]}`; undefined when the endpoint said nothing usable. */
export function parseScopes(json: unknown): string[] | undefined {
  const s = (json && typeof json === 'object' ? (json as { scopes?: unknown }).scopes : undefined);
  return Array.isArray(s) ? s.filter((x): x is string => typeof x === 'string') : undefined;
}
