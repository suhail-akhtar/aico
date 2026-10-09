/**
 * What an Azure DevOps token is advised to have, and the one sign that it has far more.
 *
 * WHY different from GitHub's. Azure DevOps never tells a caller which scopes its personal access
 * token carries (no `x-oauth-scopes`), so a "missing scope" cannot be read off a header. Whether
 * each feature works is learned by calling it (the probe in index.ts), the page shows those
 * results as chips, and the advice below is what to tick when creating the token. The only
 * over-scope signal available without a second host is indirect: a token limited to Code, Work
 * Items and Build gets 401/403 from the service-hooks listing, and a "Full access" token does not.
 * That is a heuristic and the page words it as one.
 *
 * What it does not do: call the network.
 *
 * @module connections/azure-devops/scopes
 */

import type { ScopeAdvice } from '../../../shared/connections/types.js';

export const NEEDED: readonly ScopeAdvice[] = [
  { scope: 'Code: read and write', why: 'Read repositories, open and update pull requests, and push aico/task-* branches.', feature: 'pulls', required: true },
  { scope: 'Work Items: read and write', why: 'Import work items and move them forward as the task progresses.', feature: 'items', required: false },
  { scope: 'Build: read', why: 'Show the builds that gate a pull request.', feature: 'checks', required: false },
  { scope: 'Project and Team: read', why: 'Read sprints and iterations.', feature: 'iterations', required: false },
];

export function neededScopes(): ScopeAdvice[] { return NEEDED.map(n => ({ ...n })); }

export const FULL_ACCESS_NOTE = 'Service hooks: this token can also read the organization\'s service hooks, which AICO never uses. It looks like a Full access token; create one limited to the permissions listed and revoke this one.';
