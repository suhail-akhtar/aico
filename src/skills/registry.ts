import { readFile, writeFile, mkdir } from 'fs/promises';
import path from 'path';
import os from 'os';
import type { Skill } from './types.js';
import { loadAllSkills, parseSkillFile } from './loader.js';
import { safeName } from './import.js';
import { resolveSkillRef } from './resolver.js';

type SubscriberFn = (skills: Skill[]) => void;

/**
 * A skill name reduced to something that can only be a filename.
 *
 * Throws rather than falling back to a default: a skill silently saved under a
 * name nobody asked for is worse than a refusal, because the caller goes on to
 * tell the user it worked.
 */
function safeSkillFile(name: string): string {
  const safe = safeName(name);
  if (!safe) throw new Error(`"${name}" is not a usable skill name.`);
  return safe;
}

/**
 * Where a bundled resource may be written, or nothing.
 *
 * A skill's own files are described by the model too, so `scripts/../../x` has
 * to be refused for the same reason the name is. Resolved and then checked
 * against the skill's directory, rather than pattern-matched for `..` — the
 * resolved path is the thing that matters, and it is what the check reads.
 */
function safeResourcePath(dir: string, relative: string): string | null {
  if (!relative || path.isAbsolute(relative)) return null;
  const resolved = path.resolve(dir, relative);
  const base = path.resolve(dir);
  if (!resolved.startsWith(base + path.sep)) return null;
  // SKILL.md is the entry point and is written separately; a resource claiming
  // that name would overwrite the skill with its own attachment.
  if (/^skill\.md$/i.test(path.basename(resolved))) return null;
  return resolved;
}

export class SkillRegistry {
  private _skills: Skill[] = [];
  private _subscribers: SubscriberFn[] = [];
  private _opts: { disableBuiltins?: boolean; extraDirs?: string[] } = {};

  async load(opts: { disableBuiltins?: boolean; extraDirs?: string[] } = {}): Promise<void> {
    this._opts = opts;

    // Always include ~/.aico/skills/ as a default user dir. Listing it in
    // `skills.dirs` as well is the obvious thing to do and used to scan it
    // twice, so the list is deduped by resolved path first — case-insensitively
    // where the filesystem is.
    const userSkillsDir = path.join(os.homedir(), '.aico', 'skills');
    const seen = new Set<string>();
    const dirs: string[] = [];
    for (const dir of [userSkillsDir, ...(opts.extraDirs ?? [])]) {
      const resolved = path.resolve(dir);
      const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
      if (seen.has(key)) continue;
      seen.add(key);
      dirs.push(resolved);
    }

    this._skills = await loadAllSkills({
      disableBuiltins: opts.disableBuiltins,
      extraDirs: dirs,
    });

    this._emit();
  }

  async reload(): Promise<void> {
    await this.load(this._opts);
  }

  /** Look up a skill by exact name or alias */
  lookup(commandName: string): Skill | undefined {
    const lower = commandName.toLowerCase();
    return this._skills.find(
      (s) =>
        s.frontmatter.name.toLowerCase() === lower ||
        s.frontmatter.aliases?.some((a) => a.toLowerCase() === lower),
    );
  }

  /** Check if user input auto-dispatches to a skill via its trigger pattern */
  matchTrigger(userInput: string): Skill | undefined {
    for (const skill of this._skills) {
      if (!skill.frontmatter.trigger) continue;
      try {
        if (new RegExp(skill.frontmatter.trigger, 'i').test(userInput)) return skill;
      } catch {
        // Ignore invalid trigger regexes
      }
    }
    return undefined;
  }

  list(): Skill[] {
    return [...this._skills];
  }

  subscribe(fn: SubscriberFn): () => void {
    this._subscribers.push(fn);
    fn([...this._skills]);
    return () => {
      this._subscribers = this._subscribers.filter((s) => s !== fn);
    };
  }

  /** Resolve a skill's prompt template with args, expanding ${/skill-ref} references */
  async resolvePrompt(skill: Skill, args: string): Promise<string> {
    const withArgs = skill.promptTemplate.replace('{args}', args);
    return resolveSkillRef(withArgs, (name) => this.lookup(name));
  }

  /**
   * Install a skill from a URL (raw markdown).
   * Saves to ~/.aico/skills/<name>.md
   */
  async install(url: string): Promise<Skill> {
    const { default: fetch } = await import('node-fetch');
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Failed to fetch skill: ${resp.status} ${resp.statusText}`);
    const content = await resp.text();

    const skill = parseSkillFile(content, url, false);
    if (!skill) throw new Error('Invalid skill file — missing or invalid frontmatter');

    const dir = path.join(os.homedir(), '.aico', 'skills');
    await mkdir(dir, { recursive: true });
    // The name comes out of a file fetched from a URL, so it is exactly as
    // trustworthy as the URL. Sanitised for the same reason addSkill's is.
    const filePath = path.join(dir, `${safeSkillFile(skill.frontmatter.name)}.md`);
    await writeFile(filePath, content, 'utf8');

    skill.filePath = filePath;
    // Merge into registry
    this._skills = this._skills.filter(
      (s) => s.frontmatter.name !== skill.frontmatter.name,
    );
    this._skills.push(skill);
    this._emit();

    return skill;
  }

  /**
   * Create a skill from raw markdown content and hot-merge it into the registry.
   * This is the model-callable path (via the SkillCreate tool) — it writes the
   * file to disk AND immediately makes the skill available without a manual
   * /skills reload. The orchestrator can create and use a skill in the same turn.
   *
   * **A skill can bring files with it.** A procedure worth writing down is
   * often a procedure with a script and a reference beside it — that is what
   * the directory format is for, and being able to import one but never author
   * one made the good half of the format read-only. Passing `resources` writes
   * a directory skill; passing none keeps the flat file, which is the right
   * shape for a skill that is only a prompt.
   *
   * The filename comes from a name the *model* chose, so it is sanitised. It
   * was not, and a skill named `../escaped-probe` wrote outside the skills
   * directory — verified before this was fixed, not theorised.
   */
  async addSkill(
    content: string,
    name: string,
    scope: 'user' | 'project' = 'user',
    resources: Array<{ path: string; content: string }> = [],
  ): Promise<Skill> {
    const skill = parseSkillFile(content, `addSkill:${name}`, false);
    if (!skill) throw new Error('Invalid skill file — missing frontmatter (name + description required)');

    const safe = safeSkillFile(skill.frontmatter.name);
    const root = scope === 'user'
      ? path.join(os.homedir(), '.aico', 'skills')
      : path.join(process.cwd(), '.aico', 'skills');

    let filePath: string;
    if (resources.length > 0) {
      // A directory skill: SKILL.md at the top, resources beneath it, exactly
      // the layout `importSkill` accepts and `loadSkillsFromDir` discovers.
      const dir = path.join(root, safe);
      await mkdir(dir, { recursive: true });
      filePath = path.join(dir, 'SKILL.md');
      await writeFile(filePath, content, 'utf8');

      for (const resource of resources) {
        const target = safeResourcePath(dir, resource.path);
        if (!target) continue;  // refused rather than written somewhere else
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, resource.content, 'utf8');
      }
      skill.dir = dir;
      skill.resources = resources
        .filter(r => safeResourcePath(dir, r.path))
        .map(r => r.path.replace(/\\/g, '/').replace(/^\.\//, ''));
    } else {
      await mkdir(root, { recursive: true });
      filePath = path.join(root, `${safe}.md`);
      await writeFile(filePath, content, 'utf8');
    }

    skill.filePath = filePath;
    // Hot-merge: remove any existing skill with the same name, then add
    this._skills = this._skills.filter(
      (s) => s.frontmatter.name !== skill.frontmatter.name,
    );
    this._skills.push(skill);
    this._emit();

    return skill;
  }

  private _emit(): void {
    const snapshot = [...this._skills];
    for (const fn of this._subscribers) fn(snapshot);
  }
}

export const skillRegistry = new SkillRegistry();
