import { readFile, readdir, stat } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Skill, SkillFrontmatter } from './types.js';
import { parseFrontmatter, asList, asText, type FmMap, type FmValue } from './frontmatter.js';
import { AICO_KEYS, validateFrontmatter } from './validate.js';
import { effectiveTrust } from './provenance.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** A frontmatter key in any of its spellings: `allowed-tools`, `allowedTools`, `anti-trigger`. */
function field(data: FmMap, name: string): FmValue | undefined {
  if (data[name] !== undefined) return data[name];
  const kebab = name.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`);
  if (data[kebab] !== undefined) return data[kebab];
  const camel = name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
  return data[camel];
}

/** The spec's `metadata`, as the string map it is defined to be. */
function metadataOf(data: FmMap): Record<string, string> | undefined {
  const m = data.metadata;
  if (!m || typeof m !== 'object' || Array.isArray(m)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(m)) {
    const t = asText(v);
    if (t !== undefined) out[k] = t;
  }
  return out;
}

/**
 * The frontmatter a skill file declares, read with the spec's parser.
 *
 * AICO's own keys (`trigger`, `antiTrigger`, `aliases`, `author`, `version`)
 * are read at the top level, where AICO's skills have always had them, and
 * from `metadata` as `aico-*`, where export puts them so the archive passes
 * Claude's validator (design §5.1). Top level wins when both are present.
 */
export function frontmatterOf(data: FmMap): SkillFrontmatter | null {
  const name = asText(data.name)?.trim();
  const description = asText(data.description)?.trim();
  if (!name || !description) return null;
  const meta = metadataOf(data);
  const aico = (key: keyof typeof AICO_KEYS): FmValue | undefined => field(data, key) ?? meta?.[AICO_KEYS[key]!];
  const aliases = asList(aico('aliases'));
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) extra[k] = v;
  return {
    name,
    description,
    trigger: asText(aico('trigger')) || undefined,
    antiTrigger: asText(aico('antiTrigger')) || undefined,
    aliases: aliases?.length ? aliases : undefined,
    author: asText(aico('author')) || meta?.author || undefined,
    version: asText(aico('version')) || meta?.version || undefined,
    // Claude's fields. Carried rather than dropped: a skill that says it
    // expects Bash is telling the reader something true about itself, and
    // silently discarding it on import is how "compatible" becomes "parses".
    // `allowed-tools` arrives as a YAML list, a space-separated line (the
    // spec) or a comma-separated one (AICO's older files).
    allowedTools: asList(field(data, 'allowed-tools')),
    license: asText(data.license) || undefined,
    compatibility: asText(data.compatibility) || undefined,
    metadata: meta,
    extra,
  };
}

/**
 * Parse a skill markdown file with YAML frontmatter (skills/frontmatter.ts —
 * block scalars, lists, nested `metadata`).
 *
 * Lenient where the spec says to be (agentskills.io/integrate-skills): a
 * skill with no description is skipped, because it can never be chosen; a
 * name that breaks the spec's rules loads with a warning, because refusing a
 * skill someone already uses would be a worse surprise than the rule.
 *
 * ```markdown
 * ---
 * name: commit
 * description: Generate a conventional commit message
 * aliases: [cm]
 * ---
 * Prompt template body here. {args} is replaced with user-provided arguments.
 * ```
 */
export function parseSkillFile(content: string, filePath: string, isBuiltin: boolean): Skill | null {
  const parsed = parseFrontmatter(content);
  if (!parsed.hasBlock) return null;
  const frontmatter = frontmatterOf(parsed.data);
  if (!frontmatter) return null;
  const promptTemplate = parsed.body.trim();
  const own = /^skill\.md$/i.test(path.basename(filePath)) ? path.basename(path.dirname(filePath)) : undefined;
  const check = validateFrontmatter(parsed.data, { ...(own ? { dirName: own } : {}), body: parsed.body });
  const warnings = [...parsed.errors, ...check.errors, ...check.warnings];
  return { frontmatter, promptTemplate, filePath, isBuiltin, ...(warnings.length && !isBuiltin ? { warnings } : {}) };
}

/**
 * Locate the built-in skills directory.
 *
 * The path depends on how the code was loaded, and a single hard-coded guess
 * was wrong for the shipped build: the bundler flattens modules into the output
 * root, so `__dirname` is `dist/` rather than `dist/skills/`, and the built-ins
 * copied to `dist/skills/builtin` were never found. Nothing reported it —
 * missing skills look exactly like an installation with no skills.
 *
 * So the candidates are tried in order and the first that exists wins. Running
 * from source is included last so `tsx src/index.ts` behaves like the build.
 */
export function getBuiltinDir(): string {
  const candidates = [
    path.join(__dirname, 'builtin'),               // bundled: dist/builtin
    path.join(__dirname, 'skills', 'builtin'),     // bundled with the copy step
    path.join(__dirname, '..', 'skills', 'builtin'),
    path.join(__dirname, '..', '..', 'src', 'skills', 'builtin'),
  ];
  return candidates.find(existsSync) ?? candidates[0];
}

/** Discover all .md skill files in a directory (non-recursive) */
/**
 * Every skill in a directory, in either shape.
 *
 * A flat `foo.md` is a skill; so is a folder `foo/` containing `SKILL.md`. The
 * second is Claude's format and the reason it matters is what sits beside the
 * markdown — scripts, references, templates a skill can tell the agent to read.
 * Supporting both is a few lines here and the difference between importing
 * somebody's skill and rewriting it.
 */
export async function discoverSkillFiles(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  try {
    const found: string[] = [];
    for (const entry of await readdir(dir)) {
      const full = path.join(dir, entry);
      if (entry.endsWith('.md')) { found.push(full); continue; }
      try {
        if (!(await stat(full)).isDirectory()) continue;
      } catch { continue; }
      // SKILL.md is the convention; skill.md is accepted because case is the
      // kind of thing that varies between people and should not lose a skill.
      for (const name of ['SKILL.md', 'skill.md']) {
        if (existsSync(path.join(full, name))) { found.push(path.join(full, name)); break; }
      }
    }
    return found;
  } catch {
    return [];
  }
}

/** What a directory skill ships alongside its markdown. */
async function bundledFiles(dir: string, depth = 0): Promise<string[]> {
  if (depth > 3) return [];
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    // Build artefacts are not part of the skill. Running a shipped script
    // leaves __pycache__ beside it, and listing a .pyc as something the
    // agent may read is noise at best.
    if (entry.name.startsWith('.') || /^skill\.md$/i.test(entry.name)) continue;
    if (entry.name === '__pycache__' || entry.name === 'node_modules') continue;
    const rel = entry.name;
    if (entry.isDirectory()) {
      out.push(...(await bundledFiles(path.join(dir, rel), depth + 1)).map(f => `${rel}/${f}`));
    } else {
      out.push(rel);
    }
  }
  return out;
}

/** Load all skills from a directory */
export async function loadSkillsFromDir(dir: string, isBuiltin: boolean): Promise<Skill[]> {
  const files = await discoverSkillFiles(dir);
  const skills: Skill[] = [];

  for (const filePath of files) {
    try {
      const content = await readFile(filePath, 'utf8');
      const skill = parseSkillFile(content, filePath, isBuiltin);
      if (skill) {
        // A directory skill knows where it lives, so the body can refer to
        // `scripts/build.py` and the agent can be told where that actually is.
        if (/^skill\.md$/i.test(path.basename(filePath))) {
          const own = path.dirname(filePath);
          skill.dir = own;
          skill.resources = await bundledFiles(own);
        }
        // Whether it may reach the model: an imported skill nobody reviewed,
        // or one whose files changed since, may not (skills/provenance).
        const trust = effectiveTrust(skill.dir, isBuiltin);
        skill.trust = trust.trust;
        if (trust.reason) skill.trustReason = trust.reason;
        if (trust.provenance) skill.provenance = trust.provenance;
        skills.push(skill);
      }
    } catch {
      // Skip unreadable files
    }
  }

  return skills;
}

/**
 * Load all skills from builtin + user + project dirs.
 *
 * **One skill per name, and the last one loaded wins.** Both halves matter.
 *
 * Without the dedupe a name can arrive twice — the same directory listed in
 * `skills.dirs` as well as being the default, a project and a user dir that
 * both define `review`, or an old flat `foo.md` left beside a newer
 * `foo/SKILL.md`. Every duplicate costs a line in the system prompt on every
 * single turn, and `lookup` quietly returns whichever happened to load first.
 * The registry already enforced this on the paths that install and create a
 * skill; the path that runs at every startup did not, which is the wrong one
 * to leave out.
 *
 * Last-wins rather than first-wins because the load order runs
 * builtins → user → project, so overriding a built-in skill by writing your own
 * with the same name does what you would expect instead of silently doing
 * nothing.
 */
export async function loadAllSkills(opts: {
  disableBuiltins?: boolean;
  extraDirs?: string[];
}): Promise<Skill[]> {
  const byName = new Map<string, Skill>();
  const remember = (skills: Skill[]): void => {
    for (const skill of skills) {
      const key = skill.frontmatter.name.trim().toLowerCase();
      // Delete before set so an override takes the newcomer's position rather
      // than inheriting the one it replaced — the list reads in load order.
      byName.delete(key);
      byName.set(key, skill);
    }
  };

  if (!opts.disableBuiltins) remember(await loadSkillsFromDir(getBuiltinDir(), true));

  // Extra dirs from settings (e.g. ~/.aico/skills/)
  for (const dir of opts.extraDirs ?? []) {
    remember(await loadSkillsFromDir(dir, false));
  }

  return [...byName.values()];
}
