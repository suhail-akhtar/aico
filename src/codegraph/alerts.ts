/**
 * What changed in a project's structure since it was last looked at: new
 * import cycles, new layering-rule violations, files that suddenly became
 * hotspots, files that lost their last importer — for the morning brief and
 * the code-graph monitor.
 *
 * ## Why
 *
 * A cycle or a broken layer is cheapest to undo the day it appears and
 * expensive a month later, when other code leans on it; nobody opens the
 * Code map every morning to look. The brief already runs once a day and the
 * monitors already poll; comparing two snapshots of a graph that is kept
 * fresh anyway costs no model call and milliseconds of CPU.
 *
 * ## How
 *
 * A {@link GraphSnapshot} keeps only what the comparisons need, by path (ids
 * change between builds): cycles as sorted path sets, violations as
 * `rule|from|to`, the 50 highest raw hotspot scores with their parts, the
 * orphans, and the file list (so a new file is not "newly orphaned"). Each
 * consumer has its own slot (`brief`, `monitor`), stored under
 * `aicoHome()/codegraph/alerts/`: the brief compares with the last brief, the
 * monitor with its last poll. The first snapshot is a baseline and says
 * nothing — switching on must not report everything that was already true.
 *
 * Ranked: new cycles and violations first (they are regressions someone
 * should undo), then hotspot growth and orphans (worth a look). Every alert
 * carries the files to show in the Code map and a prompt for "Ask AICO to
 * fix" — prefilled in a new chat, never sent by itself.
 *
 * @module codegraph/alerts
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { aicoHome } from '../home.js';
import { cycleWitness, cycles, layerViolations, orphans, type LayerRule } from './analyze.js';
import { storePath } from './store.js';
import type { CodeGraph } from './types.js';

export interface GraphSnapshot {
  version: string;
  /** The layering rules it was checked against (a rule change is a change). */
  rules: string;
  at: number;
  files: string[];
  /** Each import cycle as its witness loop (a → b → … → a), keyed by the sorted set. */
  cycles: Array<{ key: string; loop: string[] }>;
  /** `ruleFrom→ruleTo|fromPath|toPath`, with the rule's reason kept for the message. */
  violations: Array<{ key: string; from: string; to: string; rule: string; reason?: string }>;
  hot: Record<string, { raw: number; fanIn: number; loc: number; churn: number }>;
  orphans: string[];
}

export type AlertKind = 'cycle' | 'violation' | 'hotspot' | 'orphan';

export interface GraphAlert {
  kind: AlertKind;
  /** Stable across runs: the same cycle or violation is the same alert. */
  key: string;
  title: string;
  detail: string;
  /** Files to show; the first is the one to select. */
  files: string[];
  /** The Code map mode that shows it. */
  mode: 'cycles' | 'files' | 'hotspots';
  urgency: 'soon' | 'fyi';
  /** "Ask AICO to fix": a prompt for a new chat in the project. */
  prompt: string;
}

const HOT_KEPT = 50;
const HOT_TOP = 10;
/** A hotspot that grew by at least this factor (or arrived in the top ten). */
const HOT_GROWTH = 1.5;
const MAX_ORPHANS_LISTED = 12;

const rawHot = (f: CodeGraph['files'][number]): number => f.churn * Math.log2(2 + f.fanIn) * Math.log2(2 + f.loc / 40);

export function snapshotOf(g: CodeGraph, rules: LayerRule[], at = Date.now()): GraphSnapshot {
  const hot: GraphSnapshot['hot'] = {};
  for (const f of [...g.files].filter(x => !x.isTest).sort((a, b) => rawHot(b) - rawHot(a)).slice(0, HOT_KEPT)) {
    const raw = rawHot(f);
    if (raw > 0) hot[f.path] = { raw: Math.round(raw * 100) / 100, fanIn: f.fanIn, loc: f.loc, churn: f.churn };
  }
  return {
    version: g.version,
    rules: rules.map(r => `${r.from}>${r.to}`).join('\n'),
    at,
    files: g.files.map(f => f.path),
    cycles: cycles(g).slice(0, 200).map(c => {
      const loop = cycleWitness(g, c).map(id => g.files[id]!.path);
      return { key: c.map(id => g.files[id]!.path).sort().join('\n'), loop };
    }),
    violations: layerViolations(g, rules).slice(0, 500).map(v => {
      const rule = `${v.rule.from} ↛ ${v.rule.to}`;
      const from = g.files[v.from]!.path;
      const to = g.files[v.to]!.path;
      return { key: `${rule}|${from}|${to}`, from, to, rule, ...(v.rule.reason ? { reason: v.rule.reason } : {}) };
    }),
    hot,
    orphans: orphans(g).map(id => g.files[id]!.path),
  };
}

const short = (p: string): string => p.split('/').slice(-2).join('/');

/** New since `prev`, ranked. Pure. */
export function diffSnapshots(prev: GraphSnapshot, next: GraphSnapshot): GraphAlert[] {
  const out: GraphAlert[] = [];
  const prevCycles = prev.cycles.map(c => new Set(c.key.split('\n')));
  const prevKeys = new Set(prev.cycles.map(c => c.key));
  for (const c of next.cycles) {
    if (prevKeys.has(c.key)) continue;
    const files = c.key.split('\n');
    const grewFrom = prevCycles.find(s => s.size < files.length && [...s].every(f => files.includes(f)));
    const loop = c.loop.length ? c.loop : files;
    const ring = `${loop.map(short).join(' → ')} → ${short(loop[0]!)}`;
    out.push({
      kind: 'cycle',
      key: `cycle:${createHash('sha1').update(c.key).digest('hex').slice(0, 12)}`,
      title: grewFrom ? `An import cycle grew to ${files.length} files` : `New import cycle (${files.length} files)`,
      detail: ring,
      files: loop,
      mode: 'cycles',
      urgency: 'soon',
      prompt: `The code graph found ${grewFrom ? `an import cycle that grew from ${grewFrom.size} to ${files.length} files` : 'a new import cycle'} in this project:\n\n${loop.join(' → ')} → ${loop[0]}\n\nFind the import that closed it and break the cycle without changing behaviour (move the shared code into a module both can import, or invert the dependency). Show me the change and run the project's checks.`,
    });
  }
  const prevViolations = new Set(prev.violations.map(v => v.key));
  for (const v of next.violations) {
    if (prevViolations.has(v.key)) continue;
    out.push({
      kind: 'violation',
      key: `violation:${createHash('sha1').update(v.key).digest('hex').slice(0, 12)}`,
      title: `Layering rule broken: ${short(v.from)} → ${short(v.to)}`,
      detail: `${v.rule}${v.reason ? ` (${v.reason})` : ''}`,
      files: [v.from, v.to],
      mode: 'files',
      urgency: 'soon',
      prompt: `A layering rule of this project is newly broken: ${v.from} now depends on ${v.to}, but the rule says ${v.rule}${v.reason ? ` — ${v.reason}` : ''}.\n\nChange ${v.from} so it no longer depends on ${v.to}, keeping behaviour the same (go through the layer the rule intends). Show me the change and run the project's checks.`,
    });
  }
  const ranked = Object.entries(next.hot).sort((a, b) => b[1].raw - a[1].raw).slice(0, HOT_TOP);
  for (const [file, h] of ranked) {
    const before = prev.hot[file];
    const arrived = !before && prev.files.includes(file);
    const grew = before && h.raw >= before.raw * HOT_GROWTH && (h.fanIn > before.fanIn || h.loc > before.loc || h.churn > before.churn);
    if (!arrived && !grew) continue;
    const parts = before
      ? [before.fanIn !== h.fanIn ? `imported by ${before.fanIn} → ${h.fanIn}` : '', before.loc !== h.loc ? `${before.loc} → ${h.loc} lines` : '', before.churn !== h.churn ? `${before.churn} → ${h.churn} recent commits` : ''].filter(Boolean)
      : [`imported by ${h.fanIn}`, `${h.loc} lines`, `${h.churn} recent commits`];
    out.push({
      kind: 'hotspot',
      key: `hotspot:${file}:${Math.round(h.raw)}`,
      title: `${short(file)} became a hotspot`,
      detail: parts.join(', '),
      files: [file],
      mode: 'hotspots',
      urgency: 'fyi',
      prompt: `${file} has quickly become one of this project's hotspots (${parts.join(', ')}): it changes often, many files depend on it, and it is large — where bugs and merge conflicts concentrate.\n\nLook at why it is growing and propose how to split or simplify it. Do not change code until I agree with the plan.`,
    });
  }
  const prevFiles = new Set(prev.files);
  const prevOrphans = new Set(prev.orphans);
  const orphaned = next.orphans.filter(f => prevFiles.has(f) && !prevOrphans.has(f));
  if (orphaned.length) {
    const listed = orphaned.slice(0, MAX_ORPHANS_LISTED);
    out.push({
      kind: 'orphan',
      key: `orphan:${createHash('sha1').update(orphaned.join('\n')).digest('hex').slice(0, 12)}`,
      title: orphaned.length === 1 ? `${short(orphaned[0]!)} is no longer used` : `${orphaned.length} files are no longer used`,
      detail: `${listed.map(short).join(', ')}${orphaned.length > listed.length ? `, … ${orphaned.length - listed.length} more` : ''} — nothing imports them now`,
      files: orphaned,
      mode: 'files',
      urgency: 'fyi',
      prompt: `These files lost their last importer since the code graph last looked, and are not entry points, tests or config:\n\n${listed.join('\n')}${orphaned.length > listed.length ? `\n… and ${orphaned.length - listed.length} more` : ''}\n\nCheck whether each is now dead code (search for dynamic uses too). For the dead ones, propose removing them; do not delete anything until I agree.`,
    });
  }
  return out;
}

// ── Snapshots on disk ───────────────────────────────────────────────────────

export type SnapshotSlot = 'brief' | 'monitor';

function snapshotFile(root: string): string {
  return path.join(aicoHome(), 'codegraph', 'alerts', `${createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 16)}.json`);
}

export function loadSnapshots(root: string): Partial<Record<SnapshotSlot, GraphSnapshot>> {
  try { return JSON.parse(fs.readFileSync(snapshotFile(root), 'utf8')) as Partial<Record<SnapshotSlot, GraphSnapshot>>; } catch { return {}; /* none yet: a baseline */ }
}

export function saveSnapshot(root: string, slot: SnapshotSlot, snap: GraphSnapshot): void {
  const file = snapshotFile(root);
  const all = loadSnapshots(root);
  all[slot] = snap;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all));
  fs.renameSync(tmp, file);
}

/**
 * Compare `g` with the slot's last snapshot and keep the new one. The first
 * time is a baseline (`baseline: true`, no alerts); an unchanged graph says
 * nothing and keeps the old snapshot.
 */
export function compareWithLast(root: string, slot: SnapshotSlot, g: CodeGraph, rules: LayerRule[], now = Date.now()): { alerts: GraphAlert[]; baseline: boolean } {
  const prev = loadSnapshots(root)[slot];
  const next = snapshotOf(g, rules, now);
  if (prev && prev.version === next.version && prev.rules === next.rules) return { alerts: [], baseline: false };
  saveSnapshot(root, slot, next);
  if (!prev) return { alerts: [], baseline: true };
  return { alerts: diffSnapshots(prev, next), baseline: false };
}

/** Whether this project has ever been indexed here (the brief does not index projects nobody opened). */
export function hasGraphStore(root: string): boolean {
  try { return fs.existsSync(storePath(root)); } catch { return false; }
}
