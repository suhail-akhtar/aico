/**
 * The corpus: everything an observation run saw, appended as it happens.
 *
 * One folder per reconstruction under `aicoHome()/cleanroom/<id>/`:
 * `journey.jsonl` is append-only (one step per line, torn last line tolerated,
 * as in every other journal here) and `frames/<seq>.png` holds the screenshots,
 * kept out of the JSON so the log stays small and greppable. `meta.json` names
 * the target. This folder is the *observer's* side of the firewall: nothing the
 * implementer is given is read from here; the spec is synthesised from it
 * (spec.ts) and only the spec is copied out (implementer.ts).
 *
 * @module cleanroom/recorder
 */

import fs from 'node:fs';
import path from 'node:path';
import { aicoHome } from '../home.js';
import type { Journey, LaunchSpec, Step } from './types.js';

export function corpusDir(id: string): string {
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(id)) throw new Error('a reconstruction id is letters, digits, dot, dash and underscore');
  return path.join(aicoHome(), 'cleanroom', id);
}

export class Recorder {
  private seq = 0;
  readonly dir: string;
  /** `keepMeta`: a resumed run keeps the original target, time and platform instead of rewriting them. */
  constructor(readonly id: string, readonly target: LaunchSpec, opts: { keepMeta?: boolean } = {}) {
    this.dir = corpusDir(id);
    fs.mkdirSync(path.join(this.dir, 'frames'), { recursive: true });
    if (!(opts.keepMeta && fs.existsSync(path.join(this.dir, 'meta.json')))) fs.writeFileSync(path.join(this.dir, 'meta.json'), JSON.stringify({ id, target, createdAt: new Date().toISOString(), platform: process.platform, node: process.version }, null, 2));
    const existing = path.join(this.dir, 'journey.jsonl');
    if (fs.existsSync(existing)) this.seq = fs.readFileSync(existing, 'utf8').split('\n').filter(Boolean).length;
  }

  append(step: Omit<Step, 'seq'>): Step {
    const seq = ++this.seq;
    const { frame, ...rest } = step.observation;
    const stored: Step = { ...step, seq, observation: { ...rest, ...(frame ? { frame: undefined } : {}) } };
    if (frame) fs.writeFileSync(path.join(this.dir, 'frames', `${seq}.png`), frame);
    fs.appendFileSync(path.join(this.dir, 'journey.jsonl'), JSON.stringify(stored) + '\n');
    return { ...stored, observation: step.observation };
  }
}

export function readJourney(id: string): Journey {
  const dir = corpusDir(id);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')) as { target: LaunchSpec; platform?: string };
  const file = path.join(dir, 'journey.jsonl');
  const steps: Step[] = [];
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { steps.push(JSON.parse(line) as Step); } catch { /* a torn last line from a crash: the steps before it stand */ }
    }
  }
  return { id, target: meta.target, steps, ...(meta.platform ? { platform: meta.platform } : {}) };
}

export function frameFile(id: string, seq: number): string | undefined {
  const f = path.join(corpusDir(id), 'frames', `${seq}.png`);
  return fs.existsSync(f) ? f : undefined;
}
