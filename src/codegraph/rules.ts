/**
 * A project's layering rules — "files matching `from` must not depend on
 * files matching `to`" — gathered from every place a person may write them,
 * as one list: union, never override.
 *
 * ## Why union
 *
 * Rules are checks. A rule the person set for every project, or for this one
 * in their own settings, must not disappear because a cloned repository's
 * `.aico/settings.json` says `"rules": []` (settings-project-policy: a project
 * may only *tighten*). So the sources add up:
 *
 * - user settings `codeGraph.rules` (every project);
 * - user settings `codeGraph.projects["<absolute project path>"].rules`;
 * - the project's `.aico/settings.json` / `.aico/settings.local.json`
 *   `codeGraph.rules`;
 * - the project's `.aico/codegraph.json` `{ "rules": [...] }` — a file a team
 *   commits; AICO reads it and never writes it.
 *
 * Duplicates (same `from`, `to`) are kept once. Read from disk on each call
 * (small files), so the tool, the Code map and the brief agree without
 * sharing state.
 *
 * @module codegraph/rules
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { aicoHome } from '../home.js';
import type { LayerRule } from './analyze.js';
import { keyOf } from './paths.js';

const MAX_RULES = 100;

export function validRules(v: unknown): LayerRule[] {
  if (!Array.isArray(v)) return [];
  return v.filter((r): r is LayerRule => Boolean(r) && typeof (r as LayerRule).from === 'string' && typeof (r as LayerRule).to === 'string' && Boolean((r as LayerRule).from) && Boolean((r as LayerRule).to))
    .map(r => ({ from: r.from, to: r.to, ...(typeof r.reason === 'string' && r.reason ? { reason: r.reason.slice(0, 200) } : {}) }));
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  try {
    const v = JSON.parse(await readFile(file, 'utf8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
  } catch {
    return {}; // absent or unreadable: no rules from it
  }
}

const cg = (o: Record<string, unknown>): Record<string, unknown> => (o.codeGraph && typeof o.codeGraph === 'object' ? o.codeGraph as Record<string, unknown> : {});

/** Every layering rule that applies to the project at `root`. */
export async function codeGraphRules(root: string): Promise<LayerRule[]> {
  const abs = path.resolve(root);
  const user = cg(await readJson(path.join(aicoHome(), 'settings.json')));
  const perProject = user.projects && typeof user.projects === 'object' ? user.projects as Record<string, { rules?: unknown }> : {};
  const mine = Object.entries(perProject).find(([p]) => keyOf(path.resolve(p)) === keyOf(abs))?.[1];
  const sources = [
    validRules(user.rules),
    validRules(mine?.rules),
    validRules(cg(await readJson(path.join(abs, '.aico', 'settings.json'))).rules),
    validRules(cg(await readJson(path.join(abs, '.aico', 'settings.local.json'))).rules),
    validRules((await readJson(path.join(abs, '.aico', 'codegraph.json'))).rules),
  ];
  const seen = new Set<string>();
  const out: LayerRule[] = [];
  for (const r of sources.flat()) {
    const k = `${r.from}\0${r.to}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out.slice(0, MAX_RULES);
}
