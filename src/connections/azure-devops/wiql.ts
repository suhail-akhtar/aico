/**
 * Building the WIQL query that picks which work items to import, and nothing else about it.
 *
 * WHY a module. WIQL is a SQL-like string the service parses, and one part of it is typed by a
 * person (the "Query" source: `[System.AreaPath] UNDER 'Shop\Web' AND [System.WorkItemType] = 'Bug'`).
 * Two things must hold however that text looks:
 *
 *  - **It stays inside the project.** The fragment is AND-ed with `[System.TeamProject] = @project`
 *    in parentheses, and a fragment that could close those parentheses (`1=1) OR (`) or start a
 *    second statement is refused here, with the reason, instead of being sent. The adapter also
 *    drops any returned item whose project is not the mapped one, so a gap in this check still
 *    cannot import another project's work.
 *  - **Text from the remote is data.** A label or a name is placed inside a quoted literal with its
 *    quotes doubled, never concatenated bare.
 *
 * `ChangedDate` compares by DAY unless the request carries `timePrecision=true`; the adapter sets
 * it whenever a `since` filter is used, which is what makes an incremental sync cheaper than a
 * full one (Azure DevOps has no ETag to ask "anything new?").
 *
 * What it does not do: run the query, page the results, or know any process (the states to
 * exclude arrive as an argument, read from the project's own work item types).
 *
 * @module connections/azure-devops/wiql
 */

import type { WorkItemSource } from '../../../shared/connections/types.js';
import { ConnectionError } from '../http.js';

/** Portfolio levels and test artefacts are not coding tasks for an agent; they are never imported. */
export const EXCLUDED_TYPES: readonly string[] = [
  'Epic', 'Feature', 'Initiative', 'Test Case', 'Test Plan', 'Test Suite', 'Shared Steps', 'Shared Parameter',
  'Code Review Request', 'Code Review Response', 'Feedback Request', 'Feedback Response',
];

/** A WIQL string literal: single quotes doubled, control characters dropped. */
export function literal(s: string): string {
  // eslint-disable-next-line no-control-regex
  return `'${s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/'/g, "''")}'`;
}

/** Parentheses outside quotes balance and never go negative; false when the text ends inside a quote. */
function balanced(text: string): boolean {
  let depth = 0;
  let quote: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === quote) {
        if (text[i + 1] === quote) i++; // doubled quote inside a literal
        else quote = undefined;
      }
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === '[') { const j = text.indexOf(']', i); if (j < 0) return false; i = j; }
    else if (c === '(') depth++;
    else if (c === ')' && --depth < 0) return false;
  }
  return depth === 0 && quote === undefined;
}

/** The part of the text outside quotes and field brackets, for keyword checks. */
function bare(text: string): string {
  return text.replace(/'(?:[^']|'')*'/g, "''").replace(/"[^"]*"/g, '""').replace(/\[[^\]]*\]/g, '[]');
}

/** A person-typed condition, checked. Throws a ConnectionError that says what to write instead. */
export function checkCondition(raw: string): string {
  const text = raw.trim();
  if (!text) throw new ConnectionError('Importing by query needs a WIQL condition, for example [System.AreaPath] UNDER \'Shop\\Web\'.', 'config');
  if (text.length > 600) throw new ConnectionError('The query is too long (600 characters at most).', 'config');
  if (text.includes(';')) throw new ConnectionError('Write one condition, without ";".', 'config');
  if (/[\u0000-\u001f\u007f]/.test(text)) throw new ConnectionError('The query contains a control character.', 'config');
  if (/\b(?:select|from|order\s+by|asof|group\s+by)\b/i.test(bare(text))) {
    throw new ConnectionError('Write only the conditions (what follows WHERE). AICO adds SELECT, the project and the ordering.', 'config');
  }
  if (!balanced(text)) throw new ConnectionError('The parentheses or quotes in the query do not balance.', 'config');
  return text;
}

export interface WiqlInput {
  source: WorkItemSource;
  value?: string;
  /** Not used for `assigned-to-me`: `@Me` is the token's own identity, resolved by the service. */
  since?: string;
  state: 'open' | 'closed' | 'all';
  /** Names of the Completed and Removed states of the project's types (union). Empty when unknown. */
  closedStates: readonly string[];
}

/** The query text. `@project` is resolved by the service from the URL's project. */
export function buildWiql(i: WiqlInput): string {
  const where: string[] = ['[System.TeamProject] = @project'];
  where.push(`[System.WorkItemType] NOT IN (${EXCLUDED_TYPES.map(literal).join(', ')})`);
  if (i.state !== 'all' && i.closedStates.length > 0) {
    where.push(`[System.State] ${i.state === 'open' ? 'NOT IN' : 'IN'} (${[...new Set(i.closedStates)].map(literal).join(', ')})`);
  }
  if (i.since) where.push(`[System.ChangedDate] >= ${literal(i.since)}`);
  switch (i.source) {
    case 'assigned-to-me': where.push('[System.AssignedTo] = @Me'); break;
    case 'label': {
      const label = (i.value ?? '').trim();
      if (!label) throw new ConnectionError('Importing by tag needs a tag name.', 'config');
      if (label.includes(';')) throw new ConnectionError('A tag cannot contain ";".', 'config');
      where.push(`[System.Tags] CONTAINS ${literal(label.slice(0, 80))}`);
      break;
    }
    case 'query': where.push(`(${checkCondition(i.value ?? '')})`); break;
    case 'off': break;
  }
  return `SELECT [System.Id] FROM WorkItems WHERE ${where.join(' AND ')} ORDER BY [System.ChangedDate] DESC`;
}

/** Split ids into the batches `workitemsbatch` accepts (200 at most), keeping order. */
export function batches<T>(ids: readonly T[], size = 200): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}
