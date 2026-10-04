/**
 * The engine's HTTP routes, read out of the source.
 *
 * `aico serve` dispatches with plain string comparisons spread over several
 * modules (src/server/*.ts, src/vault/http.ts) rather than a framework's
 * route table, so there is no list to consult. Two security tools need one:
 * the static scan (scripts/security-scan.mjs) refuses a route nobody has
 * classified in scripts/security/routes.json — a new write route lands with a
 * stated gate or not at all — and the DAST suite (scripts/security-dast.mjs)
 * attacks every route it finds here, so a route added tomorrow is attacked
 * tomorrow without anyone remembering to add it.
 *
 * Regex over source on purpose: it runs in the standards job with no build.
 * The shapes it understands are the ones the server uses today; if a module
 * starts dispatching differently the count drops, and the scan's "route
 * vanished from the source" message says so rather than going quiet.
 */

import fs from 'fs';
import path from 'path';

/** Files that dispatch `/api/<route>`. */
export const ROUTE_FILES = [
  'src/server/index.ts',
  'src/server/api-system.ts',
  'src/server/artifact-routes.ts',
  'src/server/canvas-routes.ts',
  'src/server/deck-visual-routes.ts',
  'src/vault/http.ts',
];

function lineOf(text, index) { return text.slice(0, index).split('\n').length; }

/**
 * Every route as `{ route, prefix, file, line }`. `prefix: true` marks a
 * `route.startsWith('x/')` family (deck-media/<id>, brief/<action>, …).
 * @param {string} root repository root
 */
export function extractRoutes(root) {
  const out = new Map();
  const add = (route, prefix, file, line) => {
    const key = prefix ? `${route}*` : route;
    if (!out.has(key)) out.set(key, { route, prefix, file, line });
  };
  for (const file of ROUTE_FILES) {
    let text;
    try { text = fs.readFileSync(path.join(root, file), 'utf8'); } catch { continue; }
    if (file === 'src/vault/http.ts') {
      const start = text.indexOf('export async function handleVaultRoute');
      if (start < 0) continue;
      const body = text.slice(start);
      for (const m of body.matchAll(/^ {6,8}case '([a-z][\w-]*)':/gm)) add(`vault/${m[1]}`, false, file, lineOf(text, start + m.index));
      continue;
    }
    for (const m of text.matchAll(/\broute === '([^']+)'/g)) add(m[1], false, file, lineOf(text, m.index));
    for (const m of text.matchAll(/\broute\.startsWith\('([^']+\/)'\)/g)) add(m[1], true, file, lineOf(text, m.index));
    if (file === 'src/server/index.ts') {
      // The POST switch in api(): `switch (route) {` with cases six spaces in.
      const at = text.indexOf('    switch (route) {');
      if (at >= 0) for (const m of text.slice(at).matchAll(/^ {6}case '([^']+)':/gm)) add(m[1], false, file, lineOf(text, at + m.index));
    }
    if (file === 'src/server/api-system.ts') {
      // The top-level switch in handleSystemRoute is indented four spaces;
      // deeper `case`s are actions inside a route, not routes.
      for (const m of text.matchAll(/^ {4}case '([^']+)':/gm)) add(m[1], false, file, lineOf(text, m.index));
    }
  }
  // A family prefix that is only the dispatcher's own "is this mine?" test
  // (`artifacts/`, `canvas/`, `vault/`, `deck/`) is covered by its members.
  const routes = [...out.values()];
  return routes.filter(r => !r.prefix || !routes.some(o => !o.prefix && o.route.startsWith(r.route)));
}
