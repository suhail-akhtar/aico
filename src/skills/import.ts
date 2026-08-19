/**
 * Bringing a skill in from outside.
 *
 * Skills are worth having because someone already worked the procedure out. If
 * the only way to get one is to retype it, most of that value is lost before it
 * arrives — so a skill someone published as a zip, a folder, or a bare
 * `SKILL.md` should install by naming it.
 *
 * **Claude's format is the one to be compatible with**, because it is the one
 * people actually have: a directory whose `SKILL.md` carries `name` and
 * `description` in frontmatter, alongside whatever scripts and references the
 * procedure refers to. Ours reads that directly, keeps the directory intact,
 * and leaves the bundled files where the markdown expects them.
 *
 * **Nothing is executed on import.** A skill can ship scripts, and a format
 * that runs them while installing would make "try this skill" mean "run a
 * stranger's code". They are copied and listed; running one is a decision the
 * agent takes later, out loud, with the same tools it uses for everything else.
 *
 * **Unzipping shells out, and tries more than one thing.** A dependency whose
 * only job is unpacking one file format is a poor trade, but "just run tar" is
 * wrong on the most common developer machine there is: Git for Windows puts GNU
 * tar first on PATH, GNU tar cannot read zip at all, and handed a zip on a drive letter
 * it decides `E:` is a remote host and fails with a connection error. So the
 * candidates are tried in turn until one works, and if none do the error says
 * to unzip it by hand rather than leaving a mystery.
 *
 * @module skills/import
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { parseSkillFile } from './loader.js';

const run = promisify(execFile);

/** Built from escapes so no literal control character appears in this source. */
const LF = String.fromCharCode(10);
const CRLF = String.fromCharCode(13) + LF;
/** A `---` block at the very top, whatever follows it. */
const FRONTMATTER = new RegExp('^---\\n[\\s\\S]*?\\n---');

/** A UTF-8 BOM survives a round trip through some editors and breaks a `^` anchor. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
}

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
  return path.join(os.homedir(), '.aico', 'skills');
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

/** The `SKILL.md` inside a directory, whatever its case. */
function findSkillMarkdown(dir: string): string | undefined {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
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
    const entries = fs.readdirSync(current, { withFileTypes: true }).filter(e => !e.name.startsWith('.'));
    const onlyChild = entries.length === 1 && entries[0]!.isDirectory() ? entries[0]!.name : undefined;
    if (!onlyChild) return current;
    current = path.join(current, onlyChild);
  }
  return current;
}

/** Copy a tree, skipping the things nobody means to ship. */
function copyTree(from: string, to: string): string[] {
  const copied: string[] = [];
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '__MACOSX') continue;
    if (entry.name === '__pycache__') continue;
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) {
      copied.push(...copyTree(src, dst).map(f => `${entry.name}/${f}`));
    } else if (entry.isFile()) {
      fs.copyFileSync(src, dst);
      copied.push(entry.name);
    }
  }
  return copied;
}

/**
 * Ways to unpack an archive, best first.
 *
 * On Windows the system tar is named explicitly rather than trusted from PATH,
 * because Git's GNU tar shadows it and cannot read zip. `Expand-Archive` is the
 * fallback that is always present. On POSIX, `unzip` handles zip and `tar`
 * handles everything else.
 */
function extractors(archive: string, into: string): { file: string; args: string[] }[] {
  const isZip = /\.(zip|skill)$/i.test(archive);
  if (process.platform === 'win32') {
    const system = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
    return [
      { file: system, args: ['-xf', archive, '-C', into] },
      {
        file: 'powershell',
        args: ['-NoProfile', '-NonInteractive', '-Command',
          `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' `
          + `-DestinationPath '${into.replace(/'/g, "''")}' -Force`],
      },
      { file: 'tar', args: ['-xf', archive, '-C', into] },
    ];
  }
  return isZip
    ? [
      { file: 'unzip', args: ['-q', archive, '-d', into] },
      { file: 'tar', args: ['-xf', archive, '-C', into] },
    ]
    : [{ file: 'tar', args: ['-xf', archive, '-C', into] }];
}

/** Extract an archive into a fresh temporary directory. */
async function extract(archive: string): Promise<string> {
  const into = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-skill-'));
  const tried: string[] = [];

  for (const { file, args } of extractors(archive, into)) {
    try {
      await run(file, args);
      // A tool can exit zero and unpack nothing; the archive is only extracted
      // once something is actually there.
      if (fs.readdirSync(into).length > 0) return into;
      tried.push(`${path.basename(file)} (produced nothing)`);
    } catch (err) {
      const why = err instanceof Error ? err.message.split('\n')[0] : 'failed';
      tried.push(`${path.basename(file)} (${why})`);
    }
  }

  fs.rmSync(into, { recursive: true, force: true });
  throw new Error(
    `Could not unpack ${path.basename(archive)}. Tried: ${tried.join('; ')}. `
    + 'Unzip it yourself and import the folder instead — that path needs no external tool.',
  );
}

/**
 * Install a skill from a path.
 *
 * Accepts a `.zip`/`.skill` archive, a directory, or a single markdown file.
 * The name comes from the skill's own frontmatter, not from the filename —
 * a file called `download (2).zip` should still install as what it is.
 */
export async function importSkill(
  source: string,
  opts: { overwrite?: boolean; targetDir?: string } = {},
): Promise<ImportResult> {
  const root = opts.targetDir ?? userSkillsDir();
  let staged: string | undefined;

  try {
    if (!fs.existsSync(source)) return { ok: false, error: `${source} does not exist.` };
    const stat = fs.statSync(source);

    // ── work out what we were handed, and get it into a directory ──
    let from: string;
    if (stat.isDirectory()) {
      from = unwrap(source);
    } else if (/\.(zip|skill)$/i.test(source)) {
      staged = await extract(source);
      from = unwrap(staged);
    } else if (/\.md$/i.test(source)) {
      // A lone markdown file is a whole skill; it just has no resources.
      staged = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-skill-'));
      fs.copyFileSync(source, path.join(staged, 'SKILL.md'));
      from = staged;
    } else {
      return {
        ok: false,
        error: `${path.basename(source)} is not a skill. Give me a .zip, a folder, or a SKILL.md.`,
      };
    }

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
      const body = stripBom(raw).split(CRLF).join(LF);
      const hasFrontmatter = FRONTMATTER.test(body);
      return {
        ok: false,
        error: hasFrontmatter
          ? 'SKILL.md has frontmatter but is missing name or description. Both are required, and '
            + 'the description is the only part the agent sees before choosing — without it the '
            + 'skill can never be picked.'
          : 'SKILL.md has no frontmatter. It needs a --- block with at least name and '
            + 'description.',
      };
    }
    if (!parsed.frontmatter.name || !parsed.frontmatter.description) {
      return {
        ok: false,
        error: 'A skill needs both name and description in its frontmatter. The description is '
          + 'the only part the agent sees before choosing, so a skill without one cannot be chosen.',
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

    const copied = copyTree(from, destination);
    // Normalise the entry point so the loader finds it whatever case it had.
    const landed = findSkillMarkdown(destination);
    if (landed && path.basename(landed) !== 'SKILL.md') {
      fs.renameSync(landed, path.join(destination, 'SKILL.md'));
    }

    return {
      ok: true,
      name: parsed.frontmatter.name,
      installedAt: destination,
      resources: copied.filter(f => !/^skill\.md$/i.test(f)),
      ...(existed ? { replaced: true } : {}),
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (staged) fs.rmSync(staged, { recursive: true, force: true });
  }
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
