/**
 * Behavioural diff of two specs: what one program does that the other does not.
 *
 * The twin-test replays what was *recorded*, so it cannot see behaviour the
 * recordings never touched: a route the clone has and the target does not, a
 * flag the target documents and the clone lacks. This closes that gap from the
 * other side. Explore the clone with the same explorer, synthesize its spec,
 * and diff the two specs: anything present on one side only, or present on both
 * but different, is reported.
 *
 * It compares what a spec records and nothing more: routes and the controls on
 * them, commands, flags and observed cases, API operations and the statuses and
 * response shapes they return. Texts are compared after the same scrubbing the
 * twin-test uses.
 *
 * @module cleanroom/specdiff
 */

import type { Spec } from './types.js';
import { scrub } from './twin.js';

export interface SpecDiff { onlyInTarget: string[]; onlyInClone: string[]; changed: string[]; same: number }

const keyed = <T>(items: T[], key: (t: T) => string): Map<string, T> => new Map(items.map(i => [key(i), i] as [string, T]));

function compareMaps<T>(a: Map<string, T>, b: Map<string, T>, same: (x: T, y: T) => string | undefined, out: SpecDiff, what: string): void {
  for (const [k, x] of a) {
    const y = b.get(k);
    if (!y) { out.onlyInTarget.push(`${what} ${k}`); continue; }
    const why = same(x, y);
    if (why) out.changed.push(`${what} ${k}: ${why}`); else out.same++;
  }
  for (const k of b.keys()) if (!a.has(k)) out.onlyInClone.push(`${what} ${k}`);
}

export function diffSpecs(target: Spec, clone: Spec, extraScrub: RegExp[] = []): SpecDiff {
  const out: SpecDiff = { onlyInTarget: [], onlyInClone: [], changed: [], same: 0 };
  const sc = (s: string): string => scrub(s, extraScrub);
  if (target.kind !== clone.kind) { out.changed.push(`kind: target is ${target.kind}, clone is ${clone.kind}`); return out; }
  if (target.web && clone.web) {
    const labels = (spec: Spec): Map<string, string[]> => {
      const m = new Map<string, string[]>();
      for (const r of spec.web!.routes) {
        const controls = r.states.flatMap(id => spec.web!.states.find(s => s.id === id)?.controls ?? []);
        m.set(r.path, [...new Set(controls)].sort());
      }
      return m;
    };
    const ta = labels(target), tb = labels(clone);
    compareMaps(ta, tb, (x, y) => {
      const miss = x.filter(c => !y.includes(c)), extra = y.filter(c => !x.includes(c));
      return miss.length || extra.length ? `controls differ (missing in clone: ${miss.slice(0, 4).join('; ') || 'none'}; extra in clone: ${extra.slice(0, 4).join('; ') || 'none'})` : undefined;
    }, out, 'route');
    const titles = (spec: Spec): Map<string, string> => new Map(spec.web!.routes.map(r => [r.path, sc(r.title)]));
    const tt = titles(target), ct = titles(clone);
    for (const [p, t] of tt) if (ct.has(p) && ct.get(p) !== t) out.changed.push(`route ${p}: title "${t}" vs "${ct.get(p)}"`);
  }
  if (target.cli && clone.cli) {
    type Cmd = { flags: string[]; summary: string };
    type Case = { stdout: string; stderr: string; exitCode: number | null };
    const cmds = (s: Spec): Map<string, Cmd> => new Map(s.cli!.commands.map(c => [c.path.join(' ') || '(root)', { flags: c.flags.map(f => f.name).sort(), summary: sc(c.summary) }]));
    compareMaps(cmds(target), cmds(clone), (x, y) => {
      const miss = x.flags.filter(f => !y.flags.includes(f)), extra = y.flags.filter(f => !x.flags.includes(f));
      if (miss.length || extra.length) return `flags differ (missing in clone: ${miss.join(', ') || 'none'}; extra in clone: ${extra.join(', ') || 'none'})`;
      return x.summary !== y.summary ? `summary "${x.summary}" vs "${y.summary}"` : undefined;
    }, out, 'command');
    const cases = (s: Spec): Map<string, Case> => new Map(s.cli!.cases.map(c => [`${c.args.join(' ')}${c.stdin !== undefined ? ` <${c.stdin}>` : ''}`, c]));
    compareMaps(cases(target), cases(clone), (x, y) => {
      if (x.exitCode !== y.exitCode) return `exit ${x.exitCode} vs ${y.exitCode}`;
      if (sc(x.stdout) !== sc(y.stdout)) return 'stdout differs';
      return sc(x.stderr) !== sc(y.stderr) ? 'stderr differs' : undefined;
    }, out, 'case');
  }
  if (target.api && clone.api) {
    const ops = (s: Spec) => keyed(s.api!.operations, o => `${o.method} ${o.path}`);
    compareMaps(ops(target), ops(clone), (x, y) => {
      const sx = x.responses.map(r => r.status).sort().join(','), sy = y.responses.map(r => r.status).sort().join(',');
      if (sx !== sy) return `statuses ${sx} vs ${sy}`;
      for (const r of x.responses) {
        const o = y.responses.find(z => z.status === r.status);
        if (o && JSON.stringify(r.schema ?? null) !== JSON.stringify(o.schema ?? null)) return `response ${r.status} has a different shape`;
      }
      return undefined;
    }, out, 'operation');
  }
  return out;
}

export function renderSpecDiff(d: SpecDiff): string {
  const lines = [`Spec comparison: ${d.same} item(s) agree, ${d.changed.length} differ, ${d.onlyInTarget.length} only in the target, ${d.onlyInClone.length} only in the clone.`];
  for (const x of d.onlyInTarget.slice(0, 10)) lines.push(`- missing from the clone: ${x}`);
  for (const x of d.onlyInClone.slice(0, 10)) lines.push(`- extra in the clone: ${x}`);
  for (const x of d.changed.slice(0, 10)) lines.push(`- differs: ${x}`);
  return lines.join('\n');
}
