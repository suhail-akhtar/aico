/**
 * The two entry points the server calls: once per turn, once per start.
 *
 * Both are cheap — projections over logs and files already on disk — and both
 * are best effort: learning must never fail a turn or delay a start.
 *
 * @module learning
 */

import fs from 'fs';
import path from 'path';
import type { Session } from '../session/session.js';
import type { AicoSettings } from '../settings.js';
import { loadKnowledge } from '../knowledge/store.js';
import { aicoHome } from '../home.js';
import { extractFromTurn, type Proposal } from './extract.js';
import { addProposals, listProposals } from './proposals.js';
import { fromUserSignals, type KnowledgeSeen } from './user-model.js';

export type { Proposal } from './extract.js';

/** Extract what the last turn taught and file it. Returns how many new proposals were added. */
export async function learnFromTurn(session: Session, cwd: string): Promise<number> {
  try {
    const turn = session.lastTurn;
    if (turn === 0) return 0;
    const existing = await loadKnowledge(cwd).catch(() => []);
    const proposals = extractFromTurn(session, turn, existing);
    if (proposals.length === 0) return 0;
    return addProposals(cwd, proposals);
  } catch {
    return 0;
  }
}

/**
 * Once per start: what repeats across the projects this machine knows.
 *
 * Projects are the ones the portal lists (`settings.projects`) plus the one
 * the server started in. Adopted knowledge is read from each project's
 * proposals file — the record of what a person kept — so the signal is
 * decisions, not guesses.
 */
export function proposeUserSignals(settings: AicoSettings | undefined, cwd = process.cwd()): number {
  try {
    const roots = new Set<string>([path.resolve(cwd)]);
    for (const p of settings?.projects ?? []) {
      const dir = typeof p === 'string' ? p : (p as { path?: string }).path;
      if (dir && fs.existsSync(dir)) roots.add(path.resolve(dir));
    }
    const adopted: KnowledgeSeen[] = [];
    for (const root of roots) {
      for (const p of listProposals(root, 'adopted')) {
        if (p.kind === 'knowledge' && p.trigger) adopted.push({ projectRoot: root, trigger: p.trigger, content: p.content });
      }
    }
    const proposals: Proposal[] = fromUserSignals([...roots], adopted);
    return proposals.length ? addProposals('global', proposals) : 0;
  } catch {
    return 0;
  }
}

/** Where the learning store lives, for `/doctor` and the docs. */
export function learningRoot(): string {
  return path.join(aicoHome(), 'learning');
}
