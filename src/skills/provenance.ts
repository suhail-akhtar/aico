/**
 * Where an installed skill came from, and whether a person has looked at it.
 *
 * WHY. A skill's body reaches the model as text it is asked to follow, so an
 * imported skill nobody has read is a prompt-injection channel (design §5.1,
 * F5). The record of "a person reviewed exactly this" has to live with the
 * skill and has to stop being true when the skill changes — otherwise
 * reviewing once would bless whatever the folder later becomes.
 *
 * So `.aico-meta.json` sits beside `SKILL.md` with the source, a sha256 over
 * the whole tree, and a trust level. On load the hash is recomputed: a
 * reviewed skill whose files no longer match is treated as unreviewed until
 * someone reviews it again. The file is dot-named, so the loader's resource
 * list, `verifySkillDir` and export all skip it; it never leaves the machine.
 *
 * Honest limit: this is a file in the user's store. A process that can write
 * there — including the agent's own Bash in `auto` mode — can rewrite it, as
 * it could rewrite `registry-state.json`. It makes review the default path and
 * makes "the model enabled it with the API token" impossible; it is not a
 * boundary against code already running as the user.
 *
 * Skills without the file (everything installed before 0.34, and everything a
 * person or the agent wrote here) are `authored` and load as before.
 *
 * @module skills/provenance
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { SkillProvenance, SkillTrust } from './types.js';

export const META_FILE = '.aico-meta.json';

/** Never part of a skill's identity: our own bookkeeping, and build debris. */
const SKIP = new Set([META_FILE, '.aico-draft.json', '.DS_Store', '__pycache__', 'node_modules', '.git', '__MACOSX']);

/** Every file in a skill folder, sorted, as forward-slash paths. Symlinks are not followed. */
export function listTree(dir: string): string[] {
  const out: string[] = [];
  const walk = (abs: string, rel: string, depth: number): void => {
    if (depth > 12) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (SKIP.has(e.name) || e.name.endsWith('.pyc')) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(abs, e.name), r, depth + 1);
      else if (e.isFile()) out.push(r);
    }
  };
  walk(dir, '', 0);
  return out.sort();
}

/**
 * sha256 over a skill tree: each file's path and contents, in sorted order.
 * Line endings are hashed as stored — a checkout that converts them is a
 * different set of bytes, and the review was of bytes.
 */
export function treeHash(dir: string): string {
  const h = crypto.createHash('sha256');
  for (const rel of listTree(dir)) {
    h.update(rel);
    h.update('\0');
    h.update(fs.readFileSync(path.join(dir, rel)));
    h.update('\0');
  }
  return h.digest('hex');
}

export function fileHash(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function readMeta(dir: string): SkillProvenance | undefined {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, META_FILE), 'utf8')) as SkillProvenance;
    if (!meta || typeof meta !== 'object') return undefined;
    if (meta.trust !== 'authored' && meta.trust !== 'reviewed' && meta.trust !== 'unreviewed') return undefined;
    return meta;
  } catch {
    return undefined;
  }
}

export function writeMeta(dir: string, meta: SkillProvenance): void {
  fs.writeFileSync(path.join(dir, META_FILE), JSON.stringify(meta, null, 2) + '\n', 'utf8');
}

/**
 * The trust a skill folder has *now*: its recorded trust, downgraded to
 * `unreviewed` when the files differ from the ones that were reviewed.
 */
export function effectiveTrust(dir: string | undefined, isBuiltin: boolean): {
  trust: SkillTrust; reason?: string; provenance?: SkillProvenance;
} {
  if (isBuiltin) return { trust: 'builtin' };
  if (!dir) return { trust: 'authored' };
  const meta = readMeta(dir);
  if (!meta) {
    // A file that exists but cannot be read is not "no record": fail closed.
    if (fs.existsSync(path.join(dir, META_FILE))) {
      return { trust: 'unreviewed', reason: `has an unreadable ${META_FILE} — review it again` };
    }
    return { trust: 'authored' };
  }
  if (meta.trust === 'authored') return { trust: 'authored', provenance: meta };
  if (meta.trust === 'unreviewed') return { trust: 'unreviewed', reason: 'has not been reviewed yet', provenance: meta };
  if (treeHash(dir) !== meta.sha256) {
    return { trust: 'unreviewed', reason: 'changed after it was reviewed', provenance: meta };
  }
  return { trust: 'reviewed', provenance: meta };
}

/** Record that a person reviewed this exact content. */
export function markReviewed(dir: string, base?: Partial<SkillProvenance>): SkillProvenance {
  const prior = readMeta(dir);
  const meta: SkillProvenance = {
    source: prior?.source ?? base?.source ?? dir,
    sourceKind: prior?.sourceKind ?? base?.sourceKind ?? 'folder',
    ...(prior?.sourceSha256 ?? base?.sourceSha256 ? { sourceSha256: prior?.sourceSha256 ?? base?.sourceSha256 } : {}),
    ...(prior?.plugin ?? base?.plugin ? { plugin: prior?.plugin ?? base?.plugin } : {}),
    ...(prior?.findings ?? base?.findings ? { findings: prior?.findings ?? base?.findings } : {}),
    importedAt: prior?.importedAt ?? base?.importedAt ?? new Date().toISOString(),
    sha256: treeHash(dir),
    trust: 'reviewed',
    reviewedAt: new Date().toISOString(),
  };
  writeMeta(dir, meta);
  return meta;
}
