/**
 * Where connector packs live and the record of a person's approval: files under
 * `aicoHome()/connections/custom/<id>/` and `aicoHome()/connections/packs.json`.
 *
 * Two places, one rule each, in the shape ADR 0009 gave custom tools:
 *
 *  - **The user store only.** A repository cannot ship a connector. A cloned repo pointing the engine
 *    at a host of its choosing is the project-trust lesson of 0009, and a pack names hosts and runs
 *    requests with a credential; there is no project-level pack and v1 offers no way to add one.
 *  - **An approval is a hash.** Enabling stores the digest of the exact content the person saw
 *    (format.ts `packHash`); a pack is usable only while its current digest equals it. Editing
 *    ANYTHING (a mapping, a host, a tool, a fixture) by hand, by the agent's `draft`, or by its own
 *    Write tool makes the stored digest stale, the status `needs-approval`, and every request
 *    through the pack refuse itself until a person approves the new content. That check runs on
 *    every call (`requireEnabled`), not once at enable time.
 *
 * The agent can write drafts (`writeDraft`) and record a contract test result; it cannot call
 * `setEnabled`: that function takes the digest the person was shown and is reachable only from the
 * human-gated route (server/connection-routes.ts) and the tests.
 *
 * Symlinks are never followed when reading a pack (a link out of the folder would make "the pack"
 * mean files nobody reviewed), sizes are bounded, and a read costs one stat per file when nothing
 * changed.
 *
 * Honest limit (as for tools and skills): the approval record is a file in the user's store, so a
 * process running as the user could rewrite it. The gate makes review the default path and the API
 * token insufficient; it is not a sandbox.
 *
 * @module connections/packs/store
 */

import fs from 'node:fs';
import path from 'node:path';
import { aicoHome } from '../../home.js';
import type { PackStatus } from '../../../shared/connections/packs.js';
import {
  MAX_CONNECTOR_BYTES, MAX_FILES, MAX_FIXTURE_BYTES, MAX_PACK_BYTES, MAX_TOOL_BYTES, PACK_ID_RE, packHash, validatePack, type PackReport,
} from './format.js';

export type { PackStatus };

export function packsRoot(): string { return path.join(aicoHome(), 'connections', 'custom'); }
export function packDir(id: string): string {
  if (!PACK_ID_RE.test(id)) throw new PackError(`"${id.slice(0, 50)}" is not a valid pack id.`);
  return path.join(packsRoot(), id);
}
function stateFile(): string { return path.join(aicoHome(), 'connections', 'packs.json'); }

export class PackError extends Error {
  constructor(message: string, readonly code: 'invalid' | 'not-found' | 'stale' | 'not-tested' | 'not-enabled' | 'policy' = 'invalid') { super(message); this.name = 'PackError'; }
}

const FILE_RE = /^(?:connector\.json|tools\/[a-z][a-z0-9_]{0,63}\.tool\.json|fixtures\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.json)$/;
const limitOf = (p: string): number => (p === 'connector.json' ? MAX_CONNECTOR_BYTES : p.startsWith('tools/') ? MAX_TOOL_BYTES : MAX_FIXTURE_BYTES);

// ── approval and test records ──────────────────────────────────────────────

export interface TestRecord { hash: string; at: string; ops: Record<string, { ok: boolean; detail?: string }> }
export interface PackState {
  enabled?: { hash: string; at: string };
  tested?: TestRecord;
}
interface StateDoc { version: 1; packs: Record<string, PackState> }

function readDoc(): StateDoc {
  try {
    const d = JSON.parse(fs.readFileSync(stateFile(), 'utf8')) as Partial<StateDoc>;
    return { version: 1, packs: d.packs && typeof d.packs === 'object' ? d.packs : {} };
  } catch { return { version: 1, packs: {} }; /* no record: nothing enabled, the safe reading */ }
}
function writeDoc(doc: StateDoc): void {
  const f = stateFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, f);
}
export function stateOf(id: string): PackState { return readDoc().packs[id] ?? {}; }
function patchState(id: string, fn: (s: PackState) => PackState): void {
  const doc = readDoc();
  doc.packs[id] = fn(doc.packs[id] ?? {});
  writeDoc(doc);
}

// ── reading ────────────────────────────────────────────────────────────────

function isPlainFile(p: string): boolean {
  try { const st = fs.lstatSync(p); return st.isFile() && !st.isSymbolicLink(); } catch { return false; }
}

/** Every pack file by relative path, bounded; symlinks and anything outside the format are skipped. */
export function readPackFiles(id: string): Record<string, string> | undefined {
  const dir = packDir(id);
  let st: fs.Stats;
  try { st = fs.lstatSync(dir); } catch { return undefined; }
  if (!st.isDirectory() || st.isSymbolicLink()) return undefined;
  const files: Record<string, string> = {};
  let total = 0;
  const take = (rel: string): void => {
    const abs = path.join(dir, ...rel.split('/'));
    if (!isPlainFile(abs)) return;
    if (Object.keys(files).length >= MAX_FILES + 5) return;
    const size = fs.statSync(abs).size;
    if (size > limitOf(rel) || total + size > MAX_PACK_BYTES + 1) { files[rel] = ' '.repeat(Math.min(size, limitOf(rel) + 1)); return; } // too big: stands in as an oversize file so validation reports it
    total += size;
    files[rel] = fs.readFileSync(abs, 'utf8');
  };
  take('connector.json');
  for (const sub of ['tools', 'fixtures']) {
    let names: string[] = [];
    try { names = fs.readdirSync(path.join(dir, sub)); } catch { continue; }
    for (const n of names.sort()) take(`${sub}/${n}`);
  }
  return Object.keys(files).length ? files : undefined;
}

export function listPackIds(): string[] {
  let names: fs.Dirent[] = [];
  try { names = fs.readdirSync(packsRoot(), { withFileTypes: true }); } catch { return []; }
  return names.filter(d => d.isDirectory() && PACK_ID_RE.test(d.name)).map(d => d.name).sort();
}

// ── a loaded pack ──────────────────────────────────────────────────────────

export interface LoadedPack {
  id: string;
  files: Record<string, string>;
  hash: string;
  report: PackReport;
  state: PackState;
  status: PackStatus;
  statusDetail: string;
}

const cache = new Map<string, { sig: string; files: Record<string, string>; hash: string; report: PackReport }>();

function signature(id: string): string {
  const dir = packDir(id);
  const parts: string[] = [];
  const add = (rel: string): void => {
    const abs = path.join(dir, ...rel.split('/'));
    try { const st = fs.lstatSync(abs); parts.push(`${rel}:${st.size}:${st.mtimeMs}:${st.isSymbolicLink() ? 'l' : ''}`); } catch { /* absent */ }
  };
  add('connector.json');
  for (const sub of ['tools', 'fixtures']) {
    try { for (const n of fs.readdirSync(path.join(dir, sub)).sort()) add(`${sub}/${n}`); } catch { /* none */ }
  }
  return parts.join('|');
}

export function statusOf(report: PackReport, hash: string, state: PackState): { status: PackStatus; detail: string } {
  if (report.errors.length) return { status: 'invalid', detail: `${report.errors.length} problem${report.errors.length === 1 ? '' : 's'} to fix before it can be tested.` };
  if (state.enabled) {
    if (state.enabled.hash === hash) return { status: 'enabled', detail: 'A person approved exactly this content.' };
    return { status: 'needs-approval', detail: 'It changed after a person approved it. It is switched off until someone reviews the new content and enables it again.' };
  }
  const declared = report.ops.map(o => o.name);
  const t = state.tested;
  if (t && t.hash === hash && declared.length > 0 && declared.every(n => t.ops[n]?.ok)) return { status: 'tests-passing', detail: 'Every operation passed its contract test. A person has to enable it.' };
  if (t && t.hash === hash) return { status: 'draft', detail: 'Some operations failed or have no fixture, so they stay off. A person can still enable the ones that pass.' };
  return { status: 'draft', detail: 'Not tested for this content yet. Run the contract test.' };
}

export function loadPack(id: string): LoadedPack | undefined {
  const sig = signature(id);
  let hit = cache.get(id);
  if (!hit || hit.sig !== sig) {
    const files = readPackFiles(id);
    if (!files) { cache.delete(id); return undefined; }
    hit = { sig, files, hash: packHash(files), report: validatePack(id, files) };
    cache.set(id, hit);
  }
  const state = stateOf(id);
  const { status, detail } = statusOf(hit.report, hit.hash, state);
  return { id, files: hit.files, hash: hit.hash, report: hit.report, state, status, statusDetail: detail };
}

/** Tests: forget cached reads. */
export function resetPackCacheForTest(): void { cache.clear(); }

// ── writing a draft ────────────────────────────────────────────────────────

/**
 * Write (replace) a pack's files. Validation is NOT required to save a draft: the agent iterates on
 * a broken one and reads the errors back. Only paths in the format are accepted and sizes are
 * bounded here, so a draft can never write outside its own folder.
 */
export function writeDraft(id: string, files: Record<string, string>): { hash: string; written: number } {
  const dir = packDir(id);
  const names = Object.keys(files);
  if (names.length === 0) throw new PackError('A draft needs at least connector.json.');
  if (names.length > MAX_FILES) throw new PackError(`A pack has at most ${MAX_FILES} files.`);
  let total = 0;
  for (const [rel, text] of Object.entries(files)) {
    if (!FILE_RE.test(rel)) throw new PackError(`"${rel.slice(0, 80)}" is not a pack file. Use connector.json, tools/<name>.tool.json or fixtures/<name>.json.`);
    if (typeof text !== 'string') throw new PackError(`${rel} must be text.`);
    if (text.length > limitOf(rel)) throw new PackError(`${rel} is ${text.length} bytes; the limit is ${limitOf(rel)}.`);
    total += text.length;
  }
  if (total > MAX_PACK_BYTES) throw new PackError('The pack is too large.');
  fs.mkdirSync(packsRoot(), { recursive: true });
  const tmp = `${dir}.${process.pid}.${Date.now()}.tmp`;
  fs.mkdirSync(tmp, { recursive: true });
  try {
    for (const [rel, text] of Object.entries(files)) {
      const abs = path.join(tmp, ...rel.split('/'));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, text, { encoding: 'utf8', mode: 0o600 });
    }
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(tmp, dir);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  cache.delete(id);
  return { hash: packHash(files), written: names.length };
}

export function removePack(id: string): void {
  fs.rmSync(packDir(id), { recursive: true, force: true });
  cache.delete(id);
  const doc = readDoc();
  delete doc.packs[id];
  writeDoc(doc);
}

// ── the contract record, and the person's approval ─────────────────────────

/** Record what a contract test found for exactly this content. Anyone may; it grants nothing by itself. */
export function recordTest(id: string, hash: string, ops: TestRecord['ops']): void {
  patchState(id, s => ({ ...s, tested: { hash, at: new Date().toISOString(), ops } }));
}

/**
 * Record a person's approval of exactly `hash`. The caller has proved a person (the decision gate on
 * the route); this is the write that makes a pack callable. Refused unless `hash` is the current
 * content (the person approved what they saw, and it has not changed since), the pack validates, and
 * its probe passed its contract for this content. Operations that failed stay off.
 */
export function setEnabled(id: string, hash: string): LoadedPack {
  const p = loadPack(id);
  if (!p) throw new PackError(`No pack "${id}".`, 'not-found');
  if (p.hash !== hash) throw new PackError('The pack changed after you opened it. Review the new content and enable it again.', 'stale');
  if (p.report.errors.length) throw new PackError('The pack has problems; fix them first.', 'invalid');
  const t = p.state.tested;
  if (!t || t.hash !== hash) throw new PackError('Run the contract test on this content first: a connector is enabled only with tests that passed.', 'not-tested');
  if (!t.ops['probe']?.ok) throw new PackError('The probe operation did not pass its contract, so the connection could not be tested. Fix it first.', 'not-tested');
  patchState(id, s => ({ ...s, enabled: { hash, at: new Date().toISOString() } }));
  return loadPack(id)!;
}

export function clearEnabled(id: string): void {
  patchState(id, s => { const { enabled: _e, ...rest } = s; void _e; return rest; });
}

/** The pack, only if a person approved exactly its current content. Called on every request. */
export function requireEnabled(id: string): LoadedPack & { report: PackReport & { manifest: NonNullable<PackReport['manifest']> } } {
  const p = loadPack(id);
  if (!p) throw new PackError(`The connector pack "${id}" is gone.`, 'not-found');
  if (p.status === 'enabled' && p.report.manifest) return p as ReturnType<typeof requireEnabled>;
  if (p.status === 'needs-approval') throw new PackError(`The connector "${id}" changed since a person approved it, so it is switched off. Open Connections, review it and enable it again.`, 'not-enabled');
  throw new PackError(`The connector "${id}" is not enabled. A person enables it on the Connections page after its tests pass.`, 'not-enabled');
}
