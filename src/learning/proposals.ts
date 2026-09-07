/**
 * Where proposals wait for a person.
 *
 * One JSONL file per project under `~/.aico/learning/projects/<key>/`, plus
 * one global file for lines about the user. Append-only in spirit: a status
 * change rewrites the file, because the list is small — at most 25 open, and
 * anything unadopted for thirty days is dropped as noise. A proposal that was
 * adopted or dismissed stays, so the same lesson is not proposed again.
 *
 * Adoption is the one write the system makes on the user's word: a knowledge
 * proposal becomes a knowledge entry, a profile proposal a `user`-rank profile
 * fact, a user proposal a bullet in `USER.md`. Nothing here runs without a
 * person clicking Keep.
 *
 * @module learning/proposals
 */

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { aicoHome } from '../home.js';
import { saveKnowledge } from '../knowledge/store.js';
import { updateProfile } from '../project/profile.js';
import { addUserModelLine } from './user-model.js';
import { overlap, DEDUPE_OVERLAP, type Proposal, type ProposalStatus } from './extract.js';

export const MAX_OPEN = 25;

/** The learning directory for a project: named after the folder, keyed by its path. */
export function projectKey(cwd: string): string {
  const resolved = path.resolve(cwd);
  const name = (path.basename(resolved) || 'project').replace(/[^\w.-]+/g, '-').slice(0, 40);
  const hash = createHash('sha1').update(resolved.toLowerCase()).digest('hex').slice(0, 10);
  return `${name}-${hash}`;
}

export function proposalsFile(cwd: string | 'global'): string {
  return cwd === 'global'
    ? path.join(aicoHome(), 'learning', 'global', 'proposals.jsonl')
    : path.join(aicoHome(), 'learning', 'projects', projectKey(cwd), 'proposals.jsonl');
}

function readAll(file: string): Proposal[] {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(line => {
      try { return [JSON.parse(line) as Proposal]; } catch { return []; }
    });
  } catch {
    return [];
  }
}

function writeAll(file: string, proposals: Proposal[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, proposals.map(p => JSON.stringify(p)).join('\n') + (proposals.length ? '\n' : ''), 'utf8');
}

/** Drop what has expired unadopted. Adopted and dismissed entries are kept as memory of the decision. */
function prune(proposals: Proposal[], now: number): Proposal[] {
  return proposals.filter(p => p.status !== 'open' || p.expiresAt > now);
}

export function listProposals(cwd: string | 'global', status?: ProposalStatus, now = Date.now()): Proposal[] {
  const all = prune(readAll(proposalsFile(cwd)), now);
  return (status ? all.filter(p => p.status === status) : all).sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Add proposals, skipping any already decided or already open that say the
 * same thing, and keeping the open list under the cap by dropping the oldest.
 * Returns how many were actually added.
 */
export function addProposals(cwd: string | 'global', incoming: Proposal[], now = Date.now()): number {
  const file = proposalsFile(cwd);
  let all = prune(readAll(file), now);
  let added = 0;
  for (const p of incoming) {
    if (all.some(existing => existing.id === p.id)) continue;
    const text = `${p.trigger ?? ''} ${p.content}`;
    if (all.some(existing => overlap(text, `${existing.trigger ?? ''} ${existing.content}`) >= DEDUPE_OVERLAP)) continue;
    all.push({ ...p, status: 'open' });
    added++;
  }
  const open = all.filter(p => p.status === 'open').sort((a, b) => a.createdAt - b.createdAt);
  if (open.length > MAX_OPEN) {
    const drop = new Set(open.slice(0, open.length - MAX_OPEN).map(p => p.id));
    all = all.filter(p => !drop.has(p.id));
  }
  if (added > 0 || all.length !== readAll(file).length) writeAll(file, all);
  return added;
}

export function setProposalStatus(cwd: string | 'global', id: string, status: ProposalStatus): Proposal | undefined {
  const file = proposalsFile(cwd);
  const all = readAll(file);
  const found = all.find(p => p.id === id);
  if (!found) return undefined;
  found.status = status;
  writeAll(file, all);
  return found;
}

/** Mark any open proposal that says what a just-saved knowledge entry says as adopted. */
export function markAdoptedByContent(cwd: string, trigger: string, content: string): number {
  const file = proposalsFile(cwd);
  const all = readAll(file);
  let n = 0;
  for (const p of all) {
    if (p.status !== 'open' || p.kind !== 'knowledge') continue;
    if (overlap(`${p.trigger ?? ''} ${p.content}`, `${trigger} ${content}`) >= DEDUPE_OVERLAP) { p.status = 'adopted'; n++; }
  }
  if (n) writeAll(file, all);
  return n;
}

export interface AdoptEdits {
  trigger?: string;
  content?: string;
  scope?: 'project' | 'global';
}

/**
 * Keep a proposal: write what it proposes, with the person's edits, and mark
 * it adopted. Returns where it went.
 */
export async function adoptProposal(cwd: string, id: string, edits: AdoptEdits = {}): Promise<{ ok: true; wrote: string } | { ok: false; error: string }> {
  const scopeKey = readAll(proposalsFile(cwd)).some(p => p.id === id) ? cwd : 'global';
  const proposal = readAll(proposalsFile(scopeKey)).find(p => p.id === id);
  if (!proposal) return { ok: false, error: `no proposal "${id}"` };
  const content = (edits.content ?? proposal.content).trim();
  if (!content) return { ok: false, error: 'content is empty' };

  let wrote: string;
  if (proposal.kind === 'knowledge') {
    const trigger = (edits.trigger ?? proposal.trigger ?? '').trim();
    if (!trigger) return { ok: false, error: 'a knowledge entry needs a trigger' };
    const scope = edits.scope ?? proposal.scope;
    const slug = trigger.toLowerCase().split(/\s+/).slice(0, 6).join('-').replace(/[^\w-]/g, '');
    wrote = await saveKnowledge({ id: slug || 'entry', trigger, content, ...(scope === 'global' ? {} : { projectRoot: cwd }) });
  } else if (proposal.kind === 'profile') {
    const patch = proposal.patch ?? {};
    await updateProfile(cwd, {
      ...(patch.packageManager ? { packageManager: { value: patch.packageManager, source: 'user' } } : {}),
      ...(patch.command ? { commands: { [patch.command.name]: { command: patch.command.command, source: 'user' } } } : {}),
    });
    wrote = path.join(cwd, '.aico', 'profile.json');
  } else {
    wrote = addUserModelLine(content);
  }
  setProposalStatus(scopeKey, id, 'adopted');
  return { ok: true, wrote };
}
