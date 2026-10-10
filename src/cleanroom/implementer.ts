/**
 * The implementer side of the firewall: build a clone from the spec alone.
 *
 * Two parts. {@link prepareWorkspace} makes a fresh folder holding the spec
 * (`spec/SPEC.md`, `spec/spec.json`), an empty `clone/` and a `BRIEF.md`, and
 * nothing from the observer's corpus: no frames, no journey log, no target
 * address (the API base URL is replaced by a placeholder). {@link assertSpecOnly}
 * checks that. {@link implementClone} then runs one agent turn with that folder
 * as its working directory and a brief that names no target.
 *
 * What the structure guarantees, and what it does not. The agent's *inputs*
 * are spec-only: it is never told what the target is and never handed an
 * observation. It still has shell tools, and a shell can read any path the user
 * can, so this is a separation of what the agent is given, not a sandbox
 * against a determined agent; AICO says what is enforced (AICO.md) and this is
 * the honest line. Anyone who needs a hard wall runs the implementer on a
 * machine or account that does not hold the corpus.
 *
 * Costs money: `implementClone` is a real model run with a budget cap; the
 * rest of the module is free and is what the tests exercise.
 *
 * @module cleanroom/implementer
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Spec, TargetKind } from './types.js';
import { renderMarkdown } from './spec.js';
import { WALL_TOOLS, WORKSPACE_MARKER } from './wall.js';

const STACK: Record<TargetKind, string> = {
  web: 'a small web app: static files or a minimal Node server serving them, no build step unless the spec needs one. Serve it with `node server.mjs` on the port in the PORT environment variable (default 8080).',
  cli: 'a Node.js command-line program: `node cli.mjs <args>`, no dependencies, reading stdin and writing stdout/stderr and exit codes exactly as the spec records.',
  api: 'a Node.js HTTP service with no dependencies, started with `node server.mjs`, listening on the PORT environment variable (default 8080), answering exactly the operations in the spec.',
};

/** The spec as the implementer sees it: the target's address is not part of behaviour. */
export function forImplementer(spec: Spec): Spec {
  const copy = JSON.parse(JSON.stringify(spec)) as Spec;
  if (copy.api) copy.api.baseUrl = '<BASE_URL>';
  return copy;
}

export function implementerBrief(spec: Spec): string {
  return [
    `Build a working implementation of the software described in spec/SPEC.md (machine-readable: spec/spec.json). The description is all you have: you are not given the original, its address, its source, or any recording of it, and you must not look for them. Work only inside this folder.`,
    '',
    `Target: ${STACK[spec.kind]} Put everything in clone/.`,
    '',
    'Rules:',
    '1. Reproduce the behaviour in the spec: every route, state, transition, flag, case and operation, with the same texts, exit codes, status codes and response shapes. Where the spec gives an example, match it exactly.',
    '2. For web: match the measured look (colours, fonts, sizes, radii, spacing, layout boxes at the stated viewport) from the spec. Write your own markup and styles; use plain placeholders for any image the spec does not describe.',
    '3. Where the spec says "unknown", choose the simplest reasonable behaviour and list it in clone/NOTES.md. Do not guess silently.',
    '4. Add a short clone/README.md saying how to start it.',
    '5. Run it yourself before finishing with the CloneRun tool: mode "run" for a command, mode "serve" with requests for a server. Exercise a few journeys from the spec and fix what differs. Say plainly in your final answer what you verified and what you could not.',
    '',
    'This is a clean-room workspace: you have the file tools and CloneRun, and nothing else. You can read this folder and write only inside clone/; spec/ is read-only.',
    '',
    `Coverage note from the spec: ${spec.coverage.note}`,
  ].join('\n');
}

export function prepareWorkspace(spec: Spec, dir: string): { dir: string; brief: string } {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'spec'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'clone'), { recursive: true });
  const s = forImplementer(spec);
  fs.writeFileSync(path.join(dir, 'spec', 'spec.json'), JSON.stringify(s, null, 2));
  fs.writeFileSync(path.join(dir, 'spec', 'SPEC.md'), renderMarkdown(s));
  const brief = implementerBrief(s);
  fs.writeFileSync(path.join(dir, 'BRIEF.md'), brief);
  // The marker turns the wall on for any run whose directory this is (wall.ts); it only ever restricts.
  fs.writeFileSync(path.join(dir, WORKSPACE_MARKER), 'clean-room workspace: file tools and CloneRun only; write only in clone/\n');
  return { dir, brief };
}

const ALLOWED_TOP = new Set(['spec', 'clone', 'BRIEF.md', WORKSPACE_MARKER]);

/** The workspace holds the spec and the clone and nothing else, and none of the observer's files. */
export function assertSpecOnly(dir: string, corpus?: string): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  for (const name of fs.readdirSync(dir)) if (!ALLOWED_TOP.has(name)) problems.push(`unexpected entry "${name}" in the implementer workspace`);
  const spec = path.join(dir, 'spec');
  for (const name of fs.existsSync(spec) ? fs.readdirSync(spec) : []) if (!['SPEC.md', 'spec.json'].includes(name)) problems.push(`unexpected file spec/${name}`);
  if (corpus) {
    const frames = path.join(corpus, 'frames');
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    const corpusNames = new Set(fs.existsSync(frames) ? fs.readdirSync(frames) : []);
    for (const f of walk(dir)) if (corpusNames.has(path.basename(f)) && f.endsWith('.png')) problems.push(`a corpus frame is in the workspace: ${f}`);
    const text = fs.readFileSync(path.join(spec, 'spec.json'), 'utf8');
    if (text.includes('"frame"')) problems.push('spec.json carries a frame field');
  }
  return { ok: problems.length === 0, problems };
}

export interface ImplementOptions { model: string; budgetUsd: number; maxMinutes?: number; settings: import('../settings.js').AicoSettings; provider?: import('../providers/types.js').ProviderAPI }

/** One real model run that writes the clone. Spends money, capped by `budgetUsd`. */
export async function implementClone(spec: Spec, workspace: string, o: ImplementOptions): Promise<{ text: string; stoppedBy?: 'budget' | 'time'; check: { ok: boolean; problems: string[] } }> {
  const { brief } = prepareWorkspace(spec, workspace);
  const check = assertSpecOnly(workspace);
  if (!check.ok) throw new Error(`the implementer workspace is not spec-only: ${check.problems.join('; ')}`);
  const { runHeadless } = await import('../ci/headless.js');
  const r = await runHeadless({ task: brief, model: o.model, cwd: workspace, settings: o.settings, readOnly: false, tools: [...WALL_TOOLS], budgetUsd: o.budgetUsd, ...(o.maxMinutes ? { maxMinutes: o.maxMinutes } : {}), name: `cleanroom implement ${spec.id}`, ...(o.provider ? { provider: o.provider } : {}) });
  return { text: r.text, ...(r.stoppedBy ? { stoppedBy: r.stoppedBy } : {}), check };
}
