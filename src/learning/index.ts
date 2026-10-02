/**
 * The two entry points the server calls: once per turn, once per start —
 * plus the preference-learning hooks re-exported at the bottom (ADR 0016),
 * which follow the same rule.
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

// ── Preferences: how the user works (preferences.ts, distill.ts, ADR 0016) ──

export { afterTurn as preferencesAfterTurn, afterFeedback as preferencesAfterFeedback, beforeTurn as preferencesBeforeTurn, startBatch as startPreferenceBatch } from './distill.js';
export { preferencesForTask } from './preferences.js';

/**
 * Hand edits to a canvas the agent just wrote, as preference signals.
 *
 * Only the person's first save after an agent version of that tab counts —
 * later saves are them continuing to write, not reacting to the agent.
 * Returns the unsubscribe.
 */
export async function watchCanvasEdits(
  resolveCwd: (sessionId: string) => Promise<string>,
  loadSettings: () => Promise<AicoSettings>,
): Promise<() => void> {
  const { onCanvasChange, getCanvas } = await import('../canvas/store.js');
  const { canvasEditSignal } = await import('./signals.js');
  const { noteSignals, preferencesEnabled } = await import('./distill.js');
  return onCanvasChange(change => {
    if (change.author !== 'user' || change.action !== 'update') return;
    void (async () => {
      try {
        const settings = await loadSettings();
        if (!preferencesEnabled(settings)) return;
        const cwd = await resolveCwd(change.sessionId);
        const doc = await getCanvas({ settings, cwd, sessionId: change.sessionId }, change.id);
        if (!doc) return;
        const tab = doc.versions.filter(v => (v.tab ?? 't1') === change.tabId);
        const user = tab[tab.length - 1];
        const agent = tab[tab.length - 2];
        if (!user || !agent || user.author !== 'user' || agent.author !== 'agent') return;
        const sig = canvasEditSignal({
          sessionId: change.sessionId, projectRoot: cwd, title: doc.title,
          ...(doc.language ? { language: doc.language } : {}),
          agentVersion: { content: agent.content, at: agent.at },
          userVersion: { content: user.content, at: user.at, version: user.version },
        });
        if (sig) noteSignals([sig], loadSettings);
      } catch { /* best effort: a canvas that cannot be read teaches nothing */ }
    })();
  });
}
