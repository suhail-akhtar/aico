/**
 * Bringing skills in from outside, and sending them out again.
 *
 * Skills are worth having because someone already worked the procedure out. If
 * the only way to get one is to retype it, most of that value is lost before it
 * arrives — so a skill someone published as a `.skill`, a zip, a folder, a
 * bare `SKILL.md`, a pack of many, or a Claude Code plugin should install by
 * naming it. Claude's format is the one to be compatible with, because it is
 * the one people actually have (agentskills.io).
 *
 * **Look before installing (design §5.1, §7.2; F5).** An import is two steps.
 * `stageImport` unpacks into a private staging folder under the AICO store,
 * finds every skill in it, validates each against the spec and scans every
 * file (skills/scan), and returns a *review* — files, scripts, findings with
 * file and line, provenance (source and sha256). Nothing is installed.
 * `installStaged` then copies the chosen skills into place with a
 * `.aico-meta.json` record: `reviewed` when a person pressed "Install and
 * enable" on the review screen, `unreviewed` otherwise — and an unreviewed
 * skill stays out of the catalogue and cannot be opened (skills/registry).
 * The content installed is checked against the hash that was reviewed, so the
 * staging folder cannot be swapped in between.
 *
 * **Archive safety before extraction.** Archives are read by skills/archive,
 * which judges every entry — traversal, links, devices, size, count, ratio —
 * before writing one. Folders get the same caps, and a symbolic link anywhere
 * in one refuses the import (copying it would copy whatever it points at).
 *
 * **Nothing is executed on import.** Scripts are copied and listed; running
 * one is a decision the agent takes later, out loud, through its normal tools
 * and their approvals.
 *
 * **Export is Claude's `.skill`.** A zip with the skill's folder at its root,
 * validated first, without `__pycache__`, `node_modules`, `*.pyc`,
 * `.DS_Store`, our `.aico-meta.json` or a root-level `evals/` (matching
 * `package_skill.py`). AICO's own frontmatter keys move under `metadata` as
 * `aico-*` so Claude's validator accepts the file; a skill with none of them
 * ships its SKILL.md byte for byte.
 *
 * Earlier versions shelled out to tar / Expand-Archive / unzip and checked
 * afterwards. That order is wrong for a stranger's file, and is gone.
 *
 * @module skills/import
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import os from 'os';
import { aicoHome } from '../home.js';
import { parseSkillFile, getBuiltinDir } from './loader.js';
import { parseFrontmatter, updateFrontmatter, asText, asList, type FmMap, type FmValue } from './frontmatter.js';
import { validateFrontmatter, referenceWarnings, AICO_KEYS, CLAUDE_AI_KEYS } from './validate.js';
import { scanSkillDir, type ScanFinding } from './scan.js';
import { ArchiveRefused, LIMITS, extractArchive, packZip, unsafeEntryName, type PackEntry } from './archive.js';
import { META_FILE, listTree, treeHash, fileHash, writeMeta, readMeta, effectiveTrust } from './provenance.js';
import type { SkillProvenance, SkillTrust } from './types.js';

export interface ImportResult {
  ok: boolean;
  /** The skill's name, once known. */
  name?: string;
  /** Where it was installed. */
  installedAt?: string;
  /** Files that came with it. */
  resources?: string[];
  error?: string;
  /** Set when an existing skill of the same name was replaced. */
  replaced?: boolean;
}

/** Where user skills live. */
export function userSkillsDir(): string {
  return path.join(aicoHome(), 'skills');
}

/** Where imports wait for review. Not a directory the loader scans. */
export function stagingDir(): string {
  return path.join(aicoHome(), 'skill-imports');
}

/**
 * A name safe to use as a directory, without losing which skill it is.
 *
 * Returns empty for anything that is not a real name. A dot is a legal
 * character in a skill name and `.` is not a skill: `removeSkill('.')` resolved
 * to the skills directory itself, passed a `startsWith` check that equality
 * satisfies, and recursively deleted every skill the user had. Names made only
 * of dots are refused here, and the caller checks the boundary again.
 *
 * Exported because it is the one rule, and the paths that lacked it were the
 * dangerous ones: `addSkill` takes its filename from a name the *model* chose,
 * and `install` from a name a *downloaded file* chose. Both did
 * `path.join(dir, name + '.md')` with no sanitising at all — measured, a
 * SkillCreate call naming itself `../escaped-probe` wrote outside the skills
 * directory. Separators are stripped here, so nothing can traverse.
 */
export function safeName(name: string): string {
  const cleaned = name.trim().toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 64);
  return /[a-z0-9]/.test(cleaned) ? cleaned : '';
}

/** Things nobody means to ship, skipped when copying. */
const JUNK = new Set(['.git', 'node_modules', '__MACOSX', '__pycache__', '.DS_Store', 'Thumbs.db']);

/** The `SKILL.md` inside a directory, whatever its case. */
function findSkillMarkdown(dir: string): string | undefined {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return undefined; }
  for (const entry of entries) {
    if (entry.isFile() && /^skill\.md$/i.test(entry.name)) return path.join(dir, entry.name);
  }
  return undefined;
}

/**
 * A zip often wraps everything in one folder. Descend through single-child
 * directories so `my-skill.zip/my-skill/SKILL.md` installs as `my-skill`
 * rather than a folder containing a folder.
 */
function unwrap(dir: string): string {
  let current = dir;
  for (let depth = 0; depth < 4; depth++) {
    if (findSkillMarkdown(current)) return current;
    if (fs.existsSync(path.join(current, '.claude-plugin'))) return current;
    const entries = fs.readdirSync(current, { withFileTypes: true }).filter(e => !e.name.startsWith('.') && !JUNK.has(e.name));
    const onlyChild = entries.length === 1 && entries[0]!.isDirectory() ? entries[0]!.name : undefined;
    if (!onlyChild) return current;
    current = path.join(current, onlyChild);
  }
  return current;
}

/**
 * Copy a folder into `to`, refusing what an archive would be refused for:
 * symbolic links (a link to `~/.ssh` would copy the keys), more than 2,000
 * files, more than 50 MB.
 */
function copySafe(from: string, to: string, budget = { files: 0, bytes: 0 }): string[] {
  const copied: string[] = [];
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (JUNK.has(entry.name) || entry.name.endsWith('.pyc')) continue;
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isSymbolicLink()) {
      throw new ArchiveRefused(`${src} is a symbolic link; a skill folder may contain only files and folders.`);
    }
    if (entry.isDirectory()) {
      copied.push(...copySafe(src, dst, budget).map(f => `${entry.name}/${f}`));
    } else if (entry.isFile()) {
      const size = fs.statSync(src).size;
      budget.files++;
      budget.bytes += size;
      if (budget.files > LIMITS.entries) throw new ArchiveRefused(`the folder has more than ${LIMITS.entries} files.`);
      if (budget.bytes > LIMITS.unpackedBytes) throw new ArchiveRefused(`the folder holds more than ${LIMITS.unpackedBytes / 1048576} MB.`);
      fs.copyFileSync(src, dst);
      copied.push(entry.name);
    } else {
      throw new ArchiveRefused(`${src} is a device or special file.`);
    }
  }
  return copied;
}

// ── staging ─────────────────────────────────────────────────────────────

export type SourceKind = SkillProvenance['sourceKind'];

export interface ReviewedSkill {
  name: string;
  description: string;
  /** The skill's folder inside the staged tree, '' for the root. */
  at: string;
  errors: string[];
  warnings: string[];
  files: Array<{ path: string; size: number; script?: string }>;
  findings: ScanFinding[];
  totals: { high: number; warn: number; info: number };
  scripts: Array<{ file: string; interpreter: string }>;
  /** Estimated tokens: its one catalogue line, and its body when opened. */
  tokens: { catalogue: number; body: number };
  /** sha256 of the skill's tree as reviewed. */
  sha256: string;
  allowedTools?: string[];
  license?: string;
  /** A skill of this name is already installed (or built in). */
  exists?: { builtin: boolean; trust?: SkillTrust };
}

export interface ImportReview {
  id: string;
  source: string;
  sourceKind: SourceKind;
  sourceSha256?: string;
  createdAt: string;
  skills: ReviewedSkill[];
  /** Present for a Claude Code plugin: what else it carries. */
  plugin?: { name: string; version?: string; description?: string; agents: string[]; mcpServers: string[]; commands: string[] };
  /** Things worth saying about the import as a whole. */
  notes: string[];
}

export type StageInput =
  | { path: string; label?: string }
  | { files: Array<{ path: string; base64: string }>; label?: string }
  | { markdown: string; label?: string };

/** Staged imports older than this are cleared at the next import. */
const STAGE_TTL_MS = 24 * 60 * 60 * 1000;

function pruneStaging(): void {
  const root = stagingDir();
  if (!fs.existsSync(root)) return;
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const dir = path.join(root, e.name);
    try {
      if (Date.now() - fs.statSync(dir).mtimeMs > STAGE_TTL_MS) fs.rmSync(dir, { recursive: true, force: true });
    } catch { /* best effort: a stale staging folder costs disk, nothing else */ }
  }
}

function stageFolder(id: string): string {
  if (!/^[a-f0-9]{16}$/.test(id)) throw new Error('not an import id');
  return path.join(stagingDir(), id);
}

/** Put whatever was handed over into `tree`, and say what it was. */
function materialise(input: StageInput, work: string, tree: string): { kind: SourceKind; source: string; sourceSha256?: string; executable: string[] } {
  if ('markdown' in input) {
    if (Buffer.byteLength(input.markdown) > 1024 * 1024) throw new ArchiveRefused('that SKILL.md is over 1 MB.');
    fs.mkdirSync(tree, { recursive: true });
    fs.writeFileSync(path.join(tree, 'SKILL.md'), input.markdown, 'utf8');
    return { kind: 'markdown', source: input.label ?? 'pasted SKILL.md', sourceSha256: crypto.createHash('sha256').update(input.markdown).digest('hex'), executable: [] };
  }
  if ('files' in input) {
    const files = input.files.filter(f => f.path);
    if (files.length === 1 && /\.(zip|skill)$/i.test(files[0]!.path)) {
      const archive = path.join(work, 'upload.zip');
      fs.writeFileSync(archive, Buffer.from(files[0]!.base64, 'base64'));
      const out = extractArchive(archive, tree);
      return { kind: 'archive', source: input.label ?? files[0]!.path, sourceSha256: fileHash(archive), executable: out.executable };
    }
    if (files.length > LIMITS.entries) throw new ArchiveRefused(`the upload has ${files.length} files; the limit is ${LIMITS.entries}.`);
    let bytes = 0;
    const root = path.resolve(tree);
    fs.mkdirSync(root, { recursive: true });
    const single = files.length === 1 && /\.md$/i.test(files[0]!.path);
    for (const f of files) {
      const rel = single ? 'SKILL.md' : f.path.replace(/\\/g, '/');
      const why = unsafeEntryName(rel);
      if (why) throw new ArchiveRefused(`${why}.`);
      const data = Buffer.from(f.base64, 'base64');
      bytes += data.length;
      if (bytes > LIMITS.unpackedBytes) throw new ArchiveRefused(`the upload is more than ${LIMITS.unpackedBytes / 1048576} MB.`);
      const target = path.resolve(root, rel);
      if (!target.startsWith(root + path.sep)) throw new ArchiveRefused(`"${rel}" resolves outside the folder.`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data);
    }
    return { kind: single ? 'markdown' : 'upload', source: input.label ?? (single ? files[0]!.path : 'uploaded folder'), executable: [] };
  }

  const source = path.resolve(input.path);
  if (!fs.existsSync(source)) throw new Error(`${input.path} does not exist.`);
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) throw new ArchiveRefused(`${input.path} is a symbolic link — point at the real folder or file.`);
  if (stat.isDirectory()) {
    copySafe(source, tree);
    return { kind: 'folder', source, executable: [] };
  }
  if (/\.(zip|skill)$/i.test(source)) {
    const out = extractArchive(source, tree);
    return { kind: 'archive', source, sourceSha256: fileHash(source), executable: out.executable };
  }
  if (/\.md$/i.test(source)) {
    if (stat.size > 1024 * 1024) throw new ArchiveRefused('that SKILL.md is over 1 MB.');
    fs.mkdirSync(tree, { recursive: true });
    fs.copyFileSync(source, path.join(tree, 'SKILL.md'));
    return { kind: 'markdown', source, sourceSha256: fileHash(source), executable: [] };
  }
  throw new Error(`${path.basename(source)} is not a skill. Give me a .skill or .zip, a folder, a plugin folder, or a SKILL.md.`);
}

/** A Claude Code plugin's manifest, when the folder is one. */
function readPlugin(root: string): ImportReview['plugin'] & { skillDirs: string[] } | undefined {
  const manifest = path.join(root, '.claude-plugin', 'plugin.json');
  if (!fs.existsSync(manifest)) return undefined;
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(fs.readFileSync(manifest, 'utf8')) as Record<string, unknown>; } catch { /* named below */ }
  const list = (dir: string, ext: RegExp): string[] => {
    try { return fs.readdirSync(path.join(root, dir)).filter(f => ext.test(f)).map(f => f.replace(ext, '')).sort(); } catch { return []; }
  };
  const mcp: string[] = [];
  for (const file of [path.join(root, '.mcp.json')]) {
    try {
      const m = JSON.parse(fs.readFileSync(file, 'utf8')) as { mcpServers?: Record<string, unknown> };
      mcp.push(...Object.keys(m.mcpServers ?? {}));
    } catch { /* none */ }
  }
  if (json.mcpServers && typeof json.mcpServers === 'object') mcp.push(...Object.keys(json.mcpServers as object));
  // `skills` in the manifest may name extra skill folders; `skills/` is the default.
  const declared = ([] as unknown[]).concat(json.skills ?? []).filter((s): s is string => typeof s === 'string');
  const skillDirs = ['skills', ...declared.map(s => s.replace(/^\.\//, ''))]
    .filter((d, i, a) => a.indexOf(d) === i && !unsafeEntryName(d));
  return {
    name: typeof json.name === 'string' ? json.name : path.basename(root),
    ...(typeof json.version === 'string' ? { version: json.version } : {}),
    ...(typeof json.description === 'string' ? { description: json.description } : {}),
    agents: list('agents', /\.md$/i),
    commands: list('commands', /\.md$/i),
    mcpServers: [...new Set(mcp)].sort(),
    skillDirs,
  };
}

/** Skill folders under `root`, up to `depth` levels down, as paths relative to it. */
function skillFoldersUnder(root: string, depth: number): string[] {
  const out: string[] = [];
  const walk = (abs: string, rel: string, d: number): void => {
    if (d > depth) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!e.isDirectory() || e.name.startsWith('.') || JUNK.has(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (findSkillMarkdown(path.join(abs, e.name))) out.push(r);
      else walk(path.join(abs, e.name), r, d + 1);
    }
  };
  walk(root, '', 1);
  return out;
}

/** Is a skill of this name installed in `root`, or built in? */
function existing(name: string, root: string): ReviewedSkill['exists'] | undefined {
  const safe = safeName(name);
  if (!safe) return undefined;
  const dir = path.join(root, safe);
  if (fs.existsSync(path.join(dir, 'SKILL.md')) || fs.existsSync(path.join(root, `${safe}.md`))) {
    return { builtin: false, trust: effectiveTrust(fs.existsSync(dir) ? dir : undefined, false).trust };
  }
  const builtin = getBuiltinDir();
  if (fs.existsSync(path.join(builtin, `${safe}.md`)) || fs.existsSync(path.join(builtin, safe, 'SKILL.md'))) {
    return { builtin: true, trust: 'builtin' };
  }
  return undefined;
}

/**
 * Review one skill folder: parse, validate to the spec (strict — this is a
 * skill crossing the boundary), scan, hash. Exported so an installed but
 * unreviewed skill gets the same review screen as a staged one.
 */
export function reviewSkillFolder(dir: string, at: string, opts: { executable?: string[]; targetDir?: string } = {}): ReviewedSkill {
  const markdown = findSkillMarkdown(dir);
  const raw = markdown ? fs.readFileSync(markdown, 'utf8') : '';
  const parsed = parseFrontmatter(raw);
  const data: FmMap = parsed.data;
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!markdown) errors.push('no SKILL.md in this folder.');
  else if (!parsed.hasBlock) errors.push('SKILL.md has no frontmatter — it needs a --- block with at least name and description.');
  errors.push(...parsed.errors.map(e => `frontmatter ${e}`));
  const check = validateFrontmatter(data, { dirName: path.basename(dir), body: parsed.body, strict: true });
  if (parsed.hasBlock) { errors.push(...check.errors); warnings.push(...check.warnings); }

  const files = listTree(dir);
  const fileInfo = files.map(f => {
    let size = 0;
    try { size = fs.statSync(path.join(dir, f)).size; } catch { /* listed, gone */ }
    return { path: f, size };
  });
  const texts = fileInfo.filter(f => f.size < 512 * 1024 && /\.md$/i.test(f.path))
    .map(f => ({ path: f.path, text: fs.readFileSync(path.join(dir, f.path), 'utf8') }));
  warnings.push(...referenceWarnings(parsed.body, texts));

  const exec = (opts.executable ?? []).filter(e => e.startsWith(at ? `${at}/` : '')).map(e => (at ? e.slice(at.length + 1) : e));
  const scan = scanSkillDir(dir, { executable: exec });
  const scriptOf = new Map(scan.scripts.map(s => [s.file, s.interpreter]));
  const name = asText(data.name)?.trim() || path.basename(dir);
  const description = asText(data.description)?.trim() ?? '';
  const ex = opts.targetDir ? existing(name, opts.targetDir) : undefined;
  const allowedTools = asList(data['allowed-tools'] ?? data.allowedTools);
  return {
    name,
    description,
    at,
    errors,
    warnings,
    files: fileInfo.map(f => ({ ...f, ...(scriptOf.has(f.path) ? { script: scriptOf.get(f.path)! } : {}) })),
    findings: scan.findings,
    totals: scan.totals,
    scripts: scan.scripts,
    tokens: { catalogue: Math.ceil((name.length + Math.min(description.length, 250) + 4) / 4), body: scan.bodyTokens || Math.ceil(parsed.body.length / 4) },
    sha256: treeHash(dir),
    ...(allowedTools?.length ? { allowedTools } : {}),
    ...(asText(data.license) ? { license: asText(data.license)! } : {}),
    ...(ex ? { exists: ex } : {}),
  };
}

/**
 * Unpack and review an import without installing anything.
 *
 * Returns the review (also saved beside the staged files, so `installStaged`
 * installs exactly what was reviewed), or an error naming what was refused.
 */
export async function stageImport(input: StageInput, opts: { targetDir?: string } = {}): Promise<ImportReview | { error: string }> {
  pruneStaging();
  const id = crypto.randomBytes(8).toString('hex');
  const work = stageFolder(id);
  const tree = path.join(work, 'tree');
  fs.mkdirSync(work, { recursive: true });
  try {
    const got = materialise(input, work, tree);
    const root = unwrap(tree);
    const rel = (abs: string): string => path.relative(tree, abs).split(path.sep).join('/');
    const notes: string[] = [];
    const targetDir = opts.targetDir ?? userSkillsDir();

    let kind: SourceKind = got.kind;
    let folders: string[] = [];
    const plugin = readPlugin(root);
    if (plugin) {
      kind = 'plugin';
      for (const d of plugin.skillDirs) {
        const abs = path.join(root, d);
        if (findSkillMarkdown(abs)) folders.push(rel(abs));
        else folders.push(...skillFoldersUnder(abs, 1).map(f => rel(path.join(abs, f))));
      }
      if (plugin.agents.length) notes.push(`The plugin also has ${plugin.agents.length} agent(s) (${plugin.agents.join(', ')}). Agents are not imported from plugins yet — only its skills install here.`);
      if (plugin.mcpServers.length) notes.push(`The plugin also defines MCP server(s): ${plugin.mcpServers.join(', ')}. Servers run code, so they are not added from an import — add one in Settings → MCP if you want it.`);
      if (plugin.commands.length) notes.push(`The plugin's ${plugin.commands.length} slash command(s) are not imported.`);
    } else if (findSkillMarkdown(root)) {
      folders = [rel(root)];
    } else {
      folders = skillFoldersUnder(root, 2).map(f => rel(path.join(root, f)));
      if (folders.length > 1) kind = 'pack';
    }
    folders = [...new Set(folders.map(f => (f === '.' ? '' : f)))];
    if (folders.length === 0) {
      fs.rmSync(work, { recursive: true, force: true });
      return { error: 'No SKILL.md found. A skill is a folder containing SKILL.md; a pack is a folder of those; a plugin keeps them under skills/.' };
    }

    const skills = folders.map(at => reviewSkillFolder(path.join(tree, at), at, { executable: got.executable, targetDir }));
    const seen = new Map<string, number>();
    for (const s of skills) {
      const key = s.name.toLowerCase();
      seen.set(key, (seen.get(key) ?? 0) + 1);
      if (seen.get(key)! > 1) s.errors.push(`another skill in this import is also called "${s.name}" — names must be unique.`);
    }

    const review: ImportReview = {
      id,
      source: got.source,
      sourceKind: kind,
      ...(got.sourceSha256 ? { sourceSha256: got.sourceSha256 } : {}),
      createdAt: new Date().toISOString(),
      skills,
      ...(plugin ? { plugin: { name: plugin.name, ...(plugin.version ? { version: plugin.version } : {}), ...(plugin.description ? { description: plugin.description } : {}), agents: plugin.agents, mcpServers: plugin.mcpServers, commands: plugin.commands } } : {}),
      notes,
    };
    fs.writeFileSync(path.join(work, 'review.json'), JSON.stringify(review, null, 2), 'utf8');
    return review;
  } catch (err) {
    fs.rmSync(work, { recursive: true, force: true });
    const msg = err instanceof Error ? err.message : String(err);
    return { error: err instanceof ArchiveRefused ? `Refused: ${msg}` : msg };
  }
}

/** A staged import's review, if it is still there. */
export function readStaged(id: string): ImportReview | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(stageFolder(id), 'review.json'), 'utf8')) as ImportReview;
  } catch {
    return undefined;
  }
}

export function discardStaged(id: string): boolean {
  try {
    const dir = stageFolder(id);
    if (!fs.existsSync(dir)) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

export interface InstallOutcome {
  ok: boolean;
  installed: Array<{ name: string; installedAt: string; replaced: boolean; trust: 'reviewed' | 'unreviewed' }>;
  skipped: Array<{ name: string; reason: string }>;
  error?: string;
}

/**
 * Install skills from a staged import.
 *
 * `trust: 'reviewed'` is only for a caller that has a person's yes for this
 * review (the HTTP route checks the decision gate; the model never gets it).
 * Everything else installs `unreviewed`.
 */
export function installStaged(id: string, opts: {
  select?: string[];
  overwrite?: boolean;
  trust: 'reviewed' | 'unreviewed';
  targetDir?: string;
  keepStaging?: boolean;
}): InstallOutcome {
  const review = readStaged(id);
  if (!review) return { ok: false, installed: [], skipped: [], error: 'That import is no longer staged — review it again.' };
  const root = path.resolve(opts.targetDir ?? userSkillsDir());
  const wanted = opts.select?.length ? new Set(opts.select.map(s => s.toLowerCase())) : undefined;
  const installed: InstallOutcome['installed'] = [];
  const skipped: InstallOutcome['skipped'] = [];
  const tree = path.join(stageFolder(id), 'tree');

  for (const s of review.skills) {
    if (wanted && !wanted.has(s.name.toLowerCase())) continue;
    if (s.errors.length) { skipped.push({ name: s.name, reason: `fails validation: ${s.errors[0]}` }); continue; }
    const from = path.join(tree, s.at);
    // What is installed must be what was reviewed.
    if (treeHash(from) !== s.sha256) { skipped.push({ name: s.name, reason: 'its staged files changed after the review — review it again.' }); continue; }
    const dirName = safeName(s.name);
    const dest = path.resolve(root, dirName);
    if (!dirName || dest === root || !dest.startsWith(root + path.sep)) { skipped.push({ name: s.name, reason: 'that name does not resolve inside the skills directory' }); continue; }
    const existed = fs.existsSync(dest) || fs.existsSync(path.join(root, `${dirName}.md`));
    if (existed && !opts.overwrite) { skipped.push({ name: s.name, reason: `a skill called "${s.name}" is already installed — choose replace to overwrite it.` }); continue; }
    fs.rmSync(dest, { recursive: true, force: true });
    fs.rmSync(path.join(root, `${dirName}.md`), { force: true });
    copySafe(from, dest);
    const landed = findSkillMarkdown(dest);
    if (landed && path.basename(landed) !== 'SKILL.md') fs.renameSync(landed, path.join(dest, 'SKILL.md'));
    const now = new Date().toISOString();
    writeMeta(dest, {
      source: review.sourceKind === 'pack' || review.sourceKind === 'plugin' ? `${review.source}${s.at ? `#${s.at}` : ''}` : review.source,
      sourceKind: review.sourceKind,
      sha256: treeHash(dest),
      ...(review.sourceSha256 ? { sourceSha256: review.sourceSha256 } : {}),
      importedAt: now,
      trust: opts.trust,
      ...(opts.trust === 'reviewed' ? { reviewedAt: now } : {}),
      ...(review.plugin ? { plugin: review.plugin.name } : {}),
      findings: s.totals,
    });
    installed.push({ name: s.name, installedAt: dest, replaced: existed, trust: opts.trust });
  }
  if (!opts.keepStaging) discardStaged(id);
  return { ok: installed.length > 0, installed, skipped };
}

/** The review of an installed skill, for "Review and enable" on one already on disk. */
export function reviewInstalled(dir: string): ReviewedSkill & { provenance?: SkillProvenance } {
  const r = reviewSkillFolder(dir, '');
  const provenance = readMeta(dir);
  return { ...r, ...(provenance ? { provenance } : {}) };
}

// ── low-level install (authored) ────────────────────────────────────────

/**
 * Install one skill from a path, as the author's own (no review record).
 *
 * This is the path `SkillManage register` uses to move a verified draft into
 * place, and the reason it stays: a skill written here does not need a
 * stranger's review. Imports of other people's skills go through
 * `stageImport` → `installStaged` instead. Same archive and folder limits.
 */
export async function importSkill(
  source: string,
  opts: { overwrite?: boolean; targetDir?: string } = {},
): Promise<ImportResult> {
  const root = opts.targetDir ?? userSkillsDir();
  if (!fs.existsSync(source)) return { ok: false, error: `${source} does not exist.` };
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-import-'));
  try {
    const tree = path.join(work, 'tree');
    try {
      materialise({ path: source }, work, tree);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    const from = unwrap(tree);
    const markdown = findSkillMarkdown(from);
    if (!markdown) {
      return {
        ok: false,
        error: 'No SKILL.md found. A skill is a folder containing SKILL.md, or a markdown file '
          + 'with name and description in its frontmatter.',
      };
    }

    const raw = fs.readFileSync(markdown, 'utf8');
    const parsed = parseSkillFile(raw, markdown, false);
    if (!parsed) {
      // Two different faults, and telling them apart is the difference between
      // "add a --- block" and "add one line to the block you already have".
      return {
        ok: false,
        error: parseFrontmatter(raw).hasBlock
          ? 'SKILL.md has frontmatter but is missing name or description. Both are required, and '
            + 'the description is the only part the agent sees before choosing — without it the '
            + 'skill can never be picked.'
          : 'SKILL.md has no frontmatter. It needs a --- block with at least name and '
            + 'description.',
      };
    }

    const dirName = safeName(parsed.frontmatter.name);
    if (!dirName) return { ok: false, error: `"${parsed.frontmatter.name}" is not a usable skill name.` };

    const destination = path.resolve(root, dirName);
    if (destination === path.resolve(root) || !destination.startsWith(path.resolve(root) + path.sep)) {
      return { ok: false, error: 'that name does not resolve inside the skills directory' };
    }
    const existed = fs.existsSync(destination);
    if (existed && !opts.overwrite) {
      return {
        ok: false,
        error: `A skill called "${parsed.frontmatter.name}" is already installed. `
          + 'Import again with overwrite to replace it.',
      };
    }
    if (existed) fs.rmSync(destination, { recursive: true, force: true });

    const copied = copySafe(from, destination);
    // Normalise the entry point so the loader finds it whatever case it had.
    const landed = findSkillMarkdown(destination);
    if (landed && path.basename(landed) !== 'SKILL.md') {
      fs.renameSync(landed, path.join(destination, 'SKILL.md'));
    }
    // A record copied in from the source would claim a review this copy never had.
    fs.rmSync(path.join(destination, META_FILE), { force: true });

    return {
      ok: true,
      name: parsed.frontmatter.name,
      installedAt: destination,
      resources: copied.filter(f => !/^skill\.md$/i.test(f) && f !== META_FILE && !f.startsWith('.aico-')),
      ...(existed ? { replaced: true } : {}),
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// ── export ──────────────────────────────────────────────────────────────

export interface ExportResult {
  ok: boolean;
  path?: string;
  /** The archive, when no destination was given. */
  data?: Buffer;
  name?: string;
  files?: number;
  /** SKILL.md was rewritten to move AICO's keys under `metadata`. */
  rewritten?: boolean;
  warnings?: string[];
  error?: string;
}

/**
 * SKILL.md as Claude will read it: AICO's own top-level keys moved under
 * `metadata` as `aico-*`, everything else kept as written. Unchanged (and
 * byte-identical) when there is nothing to move.
 */
export function claudeSkillMarkdown(raw: string): { text: string; rewritten: boolean; warnings: string[] } {
  const parsed = parseFrontmatter(raw);
  const warnings: string[] = [];
  const moves: Array<[string, string, FmValue]> = [];
  for (const e of parsed.entries) {
    const canonical = Object.keys(AICO_KEYS).find(k => k === e.key || k.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`) === e.key);
    if (canonical && e.value !== undefined) moves.push([e.key, AICO_KEYS[canonical]!, e.value]);
  }
  for (const e of parsed.entries) {
    if (!CLAUDE_AI_KEYS.has(e.key) && !moves.some(m => m[0] === e.key)) {
      warnings.push(`"${e.key}" is not a key claude.ai's upload validator accepts (Claude Code reads it) — kept as written.`);
    }
  }
  if (moves.length === 0) return { text: raw, rewritten: false, warnings };
  const prior = parsed.data.metadata;
  const metadata: Record<string, FmValue> = prior && typeof prior === 'object' && !Array.isArray(prior) ? { ...prior } : {};
  for (const [, metaKey, value] of moves) {
    if (metadata[metaKey] === undefined) metadata[metaKey] = Array.isArray(value) ? (asList(value) ?? []).join(', ') : asText(value) ?? '';
  }
  const patch: Record<string, FmValue | undefined> = { metadata };
  for (const [key] of moves) patch[key] = undefined;
  return { text: updateFrontmatter(raw, patch), rewritten: true, warnings };
}

/** Files that never go into a `.skill`, matching Claude's `package_skill.py` plus our own record. */
function excluded(rel: string, includeEvals: boolean): boolean {
  if (!includeEvals && (rel === 'evals' || rel.startsWith('evals/'))) return true;
  return rel.split('/').some(p => p === META_FILE || p === '.aico-draft.json' || p === '__pycache__' || p === 'node_modules' || p === '.DS_Store')
    || rel.endsWith('.pyc');
}

/**
 * Pack a skill into Claude's `.skill` format: a zip with the skill's folder at
 * the root. Validates first and refuses on any spec error — a file Claude
 * would reject is not an export.
 */
export async function exportSkill(
  skillDir: string,
  destination?: string,
  opts: { includeEvals?: boolean } = {},
): Promise<ExportResult> {
  if (!fs.existsSync(skillDir)) return { ok: false, error: `${skillDir} does not exist.` };
  const markdown = findSkillMarkdown(skillDir);
  if (!markdown) return { ok: false, error: `${skillDir} has no SKILL.md — only a directory skill can be exported.` };
  const raw = fs.readFileSync(markdown, 'utf8');
  const parsed = parseFrontmatter(raw);
  const check = validateFrontmatter(parsed.data, { body: parsed.body, strict: true });
  const errors = [...parsed.errors, ...check.errors];
  if (errors.length) {
    return { ok: false, error: `Not exported — Claude would reject this skill:\n${errors.map(e => `  - ${e}`).join('\n')}` };
  }
  const name = asText(parsed.data.name)!.trim();
  const out = claudeSkillMarkdown(raw);

  const entries: PackEntry[] = [{ name: `${name}/`, dir: true }];
  const dirs = new Set<string>();
  const files = listTree(skillDir).filter(rel => !excluded(rel, !!opts.includeEvals));
  for (const rel of files) {
    const parts = rel.split('/');
    for (let i = 1; i < parts.length; i++) {
      const d = parts.slice(0, i).join('/');
      if (!dirs.has(d)) { dirs.add(d); entries.push({ name: `${name}/${d}/`, dir: true }); }
    }
    const abs = path.join(skillDir, rel);
    const isEntry = path.resolve(abs) === path.resolve(markdown);
    const data = isEntry ? Buffer.from(out.text, 'utf8') : fs.readFileSync(abs);
    const st = fs.statSync(abs);
    // A script is executable in the archive if the file is, or if it starts with a shebang (Windows has no exec bit,
    // and a checkout or copy can drop it on POSIX).
    const execBit = (process.platform !== 'win32' && (st.mode & 0o111) !== 0) || data.subarray(0, 2).toString() === '#!';
    entries.push({ name: `${name}/${isEntry ? 'SKILL.md' : rel}`, data, mode: execBit ? 0o755 : 0o644 });
  }
  const zip = packZip(entries);
  const warnings = [...check.warnings, ...out.warnings];
  const result: ExportResult = { ok: true, name, files: files.length, rewritten: out.rewritten, warnings };
  if (destination === undefined) return { ...result, data: zip };

  const archive = /\.(zip|skill)$/i.test(destination)
    ? path.resolve(destination)
    : path.resolve(destination, `${name}.skill`);
  // Overwriting is for an earlier archive, never for some other file a typo named.
  if (fs.existsSync(archive)) {
    const head = Buffer.alloc(2);
    try { const fd = fs.openSync(archive, 'r'); fs.readSync(fd, head, 0, 2, 0); fs.closeSync(fd); } catch { /* treated as not a zip */ }
    if (head.toString('latin1') !== 'PK' && fs.statSync(archive).size > 0) {
      return { ok: false, error: `${archive} exists and is not a zip archive — choose another name.` };
    }
  }
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  fs.writeFileSync(archive, zip);
  return { ...result, path: archive };
}

/** Remove an installed skill. Built-ins are not removable. */
export function removeSkill(name: string, root = userSkillsDir()): { ok: boolean; error?: string } {
  const safe = safeName(name);
  if (!safe) return { ok: false, error: `"${name}" is not a skill name.` };

  const base = path.resolve(root);
  const dir = path.resolve(base, safe);
  // Strictly inside, not equal to. This deletes a tree, and `startsWith` alone
  // accepts the root itself — which is how one bad name became "delete every
  // skill".
  if (dir === base || !dir.startsWith(base + path.sep)) {
    return { ok: false, error: 'path is outside the skills directory' };
  }
  if (!fs.existsSync(dir)) {
    // A single-file skill from an earlier version lives as name.md.
    const flat = path.join(root, `${safeName(name)}.md`);
    if (fs.existsSync(flat)) { fs.rmSync(flat, { force: true }); return { ok: true }; }
    return { ok: false, error: `No installed skill called "${name}".` };
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return { ok: true };
}
