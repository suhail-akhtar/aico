/**
 * `aico cleanroom …`: the four stages as commands (ADR 0041).
 *
 *   observe     drive a target and record it       (free; a browser or a process)
 *   synthesize  turn a recording into a spec        (free; deterministic)
 *   implement   build a clone from the spec alone   (a model run; --budget caps it)
 *   twin        replay the journeys on the clone    (free; a browser or a process)
 *
 * Each stage reads the previous stage's folder under `aicoHome()/cleanroom/<id>/`
 * (`journey.jsonl`, `spec/`, `workspace/`), so they can be run apart, resumed,
 * or handed to an agent as separate steps. The commands add no checks about
 * what a target is or who may point them at it: this is execution
 * infrastructure and that responsibility is the operator's (ADR 0041).
 *
 * Exit codes: 0 done; 1 an error; 2 a twin-test that found differences.
 *
 * @module cleanroom/cli
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import type { AicoSettings } from '../settings.js';
import type { LaunchSpec } from './types.js';
import { explore } from './explorer.js';
import { corpusDir, readJourney } from './recorder.js';
import { synthesize, writeSpec } from './spec.js';
import { implementClone, prepareWorkspace } from './implementer.js';
import { renderTwinReport, twinTest } from './twin.js';
import type { Spec } from './types.js';

export interface CleanroomDeps { pickModel: (flag: string | undefined, settings: AicoSettings) => string; loadSettings: () => Promise<AicoSettings> }

const num = (v: string | undefined, d: number): number => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };

function launchFor(kind: string, target: string, o: { cwd?: string }, name?: string): LaunchSpec {
  if (kind === 'web') return { kind: 'web', url: target };
  if (kind === 'api') return { kind: 'api', baseUrl: target };
  if (kind === 'cli') { const parts = target.match(/"[^"]*"|\S+/g)?.map(p => p.replace(/^"|"$/g, '')) ?? []; return { kind: 'cli', command: parts[0] ?? target, args: parts.slice(1), ...(o.cwd ? { cwd: o.cwd } : {}), ...(name ? { name } : {}) }; }
  throw new Error(`kind must be web, cli or api (got "${kind}")`);
}

function readSpec(id: string): Spec {
  const f = path.join(corpusDir(id), 'spec', 'spec.json');
  if (!fs.existsSync(f)) throw new Error(`no spec for "${id}": run \`aico cleanroom synthesize ${id}\` first`);
  return JSON.parse(fs.readFileSync(f, 'utf8')) as Spec;
}

export function registerCleanroomCommands(program: Command, deps: CleanroomDeps): void {
  const cr = program.command('cleanroom').description('reconstruct software from its behaviour: observe, synthesize a spec, implement from the spec alone, twin-test');

  cr.command('observe <id> <kind> <target>')
    .description('record a target: kind web (a URL), api (a base URL) or cli (a command line)')
    .option('--max-steps <n>', 'step budget', '60')
    .option('--max-depth <n>', 'web: how deep to follow clicks', '4')
    .option('--cwd <dir>', 'cli: working directory')
    .option('--follow-external', 'web: also follow links to other origins')
    .action(async (id: string, kind: string, target: string, opts: { maxSteps: string; maxDepth: string; cwd?: string; followExternal?: boolean }) => {
      try {
        const j = await explore(id, launchFor(kind, target, opts, id), { maxSteps: num(opts.maxSteps, 60), maxDepth: num(opts.maxDepth, 4), sameOriginOnly: !opts.followExternal });
        process.stdout.write(`recorded ${j.steps.length} steps in ${corpusDir(id)}\n`);
      } catch (e) { process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`); process.exit(1); }
    });

  cr.command('synthesize <id>')
    .description('turn the recording into a behavioural spec (spec/SPEC.md and spec/spec.json)')
    .action((id: string) => {
      try {
        const spec = synthesize(readJourney(id));
        const { markdown } = writeSpec(spec, path.join(corpusDir(id), 'spec'));
        process.stdout.write(`${spec.coverage.states} states, ${spec.coverage.transitions} transitions, ${spec.unknowns.length} unknowns. Spec: ${markdown}\n`);
      } catch (e) { process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`); process.exit(1); }
    });

  cr.command('implement <id>')
    .description('build a clone from the spec alone (a model run, capped by --budget). Without --run it only prepares the workspace and prints the brief')
    .option('--run', 'run the agent now')
    .option('--budget <usd>', 'cost ceiling for the run', '3')
    .option('--minutes <n>', 'time ceiling', '30')
    .option('-m, --model <model>', 'model')
    .action(async (id: string, opts: { run?: boolean; budget: string; minutes: string; model?: string }) => {
      try {
        const spec = readSpec(id);
        const workspace = path.join(corpusDir(id), 'workspace');
        if (!opts.run) { const { brief } = prepareWorkspace(spec, workspace); process.stdout.write(`workspace: ${workspace}\n\n${brief}\n`); return; }
        const settings = await deps.loadSettings();
        const r = await implementClone(spec, workspace, { model: deps.pickModel(opts.model, settings), budgetUsd: num(opts.budget, 3), maxMinutes: num(opts.minutes, 30), settings });
        process.stdout.write(`${r.text}\n${r.stoppedBy ? `\n(stopped by the ${r.stoppedBy} limit)\n` : ''}clone: ${path.join(workspace, 'clone')}\n`);
      } catch (e) { process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`); process.exit(1); }
    });

  cr.command('twin <id> <cloneTarget>')
    .description('replay the recorded journeys on the clone and report differences (clone target: a URL for web/api, a command line for cli)')
    .option('--live', 'run each step against the real target too, instead of comparing with the recording')
    .option('--max-steps <n>', 'steps to replay', '200')
    .option('--cwd <dir>', 'cli: working directory of the clone')
    .action(async (id: string, cloneTarget: string, opts: { live?: boolean; maxSteps: string; cwd?: string }) => {
      try {
        const j = readJourney(id);
        const report = await twinTest({ journey: j, clone: launchFor(j.target.kind, cloneTarget, opts), mode: opts.live ? 'live' : 'recorded', maxSteps: num(opts.maxSteps, 200) });
        const out = path.join(corpusDir(id), 'twin-report.json');
        fs.writeFileSync(out, JSON.stringify(report, null, 2));
        process.stdout.write(`${renderTwinReport(report)}\nreport: ${out}\n`);
        process.exit(report.differences.length ? 2 : 0);
      } catch (e) { process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`); process.exit(1); }
    });
}
