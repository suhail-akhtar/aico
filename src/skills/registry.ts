import { readFile, writeFile, mkdir } from 'fs/promises';
import path from 'path';
import { aicoHome } from '../home.js';
import type { Skill } from './types.js';
import { loadAllSkills, loadSkillsFromDir, parseSkillFile } from './loader.js';
import { safeName } from './import.js';
import { resolveSkillRef } from './resolver.js';
import { currentCwd } from '../run-context.js';

/**
 * Where a project keeps its skills: AICO's own `.aico/skills`, and the
 * cross-client `.agents/skills` the Agent Skills spec suggests. Later wins on
 * a name clash, so AICO's directory is read last.
 */
export function projectSkillDirs(projectDir: string): string[] {
  return [path.join(projectDir, '.agents', 'skills'), path.join(projectDir, '.aico', 'skills')];
}

/** A cache key for a project directory, case-folded where the filesystem is. */
function projectKey(dir: string): string {
  const resolved = path.resolve(dir);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

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

/**
 * Whether `request` is the kind of request this skill declares it is for:
 * its `trigger` matches and its `antiTrigger`, if any, does not. An invalid
 * regex in either never matches — a typo in a skill file must not start
 * offering that skill for everything.
 */
export function triggerMatches(skill: Skill, request: string): boolean {
  const { trigger, antiTrigger } = skill.frontmatter;
  if (!trigger) return false;
  try {
    if (!new RegExp(trigger, 'i').test(request)) return false;
    return !(antiTrigger && new RegExp(antiTrigger, 'i').test(request));
  } catch {
    return false;
  }
}

export class SkillRegistry {
  private _skills: Skill[] = [];
  private _subscribers: SubscriberFn[] = [];
  private _opts: { disableBuiltins?: boolean; extraDirs?: string[] } = {};
  /**
   * Each project's own skills, by project directory.
   *
   * The registry is one per process, and a server drives sessions in several
   * projects; a project's skills must reach runs in that project and no other.
   * They used to be written to the *server's* directory and never read back,
   * so a project skill worked until the restart and then was gone. Now they
   * are read from disk per project (`ensureProject`, called at the start of
   * every run) and overlaid on the global list for runs whose directory it is.
   *
   * Project skills are instructions, the same tier as AICO.md, so they load
   * without the workspace-trust prompt (design §4.4); they run nothing.
   */
  private _project = new Map<string, Skill[]>();

  async load(opts: { disableBuiltins?: boolean; extraDirs?: string[] } = {}): Promise<void> {
    this._opts = opts;

    // Always include ~/.aico/skills/ as a default user dir. Listing it in
    // `skills.dirs` as well is the obvious thing to do and used to scan it
    // twice, so the list is deduped by resolved path first — case-insensitively
    // where the filesystem is.
    const userSkillsDir = path.join(aicoHome(), 'skills');
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
    this._project.clear();
    await this.load(this._opts);
  }

  /**
   * Read a project's own skills from disk, once per project until `reload`.
   *
   * Defaults to the current run's directory. Idempotent and cheap after the
   * first call, so every run can call it before its catalogue is rendered.
   */
  async ensureProject(projectDir: string = currentCwd()): Promise<void> {
    const key = projectKey(projectDir);
    if (this._project.has(key)) return;
    const byName = new Map<string, Skill>();
    for (const dir of projectSkillDirs(projectDir)) {
      for (const skill of await loadSkillsFromDir(dir, false)) {
        const name = skill.frontmatter.name.trim().toLowerCase();
        byName.delete(name);
        byName.set(name, skill);
      }
    }
    this._project.set(key, [...byName.values()]);
  }

  /**
   * The skills visible to the current run: the global list, with the current
   * project's own skills overriding by name (project wins, as the loader's
   * built-in → user → project order always meant).
   */
  private visible(): Skill[] {
    const project = this._project.get(projectKey(currentCwd()));
    if (!project?.length) return this._skills;
    const names = new Set(project.map(s => s.frontmatter.name.trim().toLowerCase()));
    return [...this._skills.filter(s => !names.has(s.frontmatter.name.trim().toLowerCase())), ...project];
  }

  /** Look up a skill by exact name or alias */
  lookup(commandName: string): Skill | undefined {
    const lower = commandName.toLowerCase();
    return this.visible().find(
      (s) =>
        s.frontmatter.name.toLowerCase() === lower ||
        s.frontmatter.aliases?.some((a) => a.toLowerCase() === lower),
    );
  }

  /** Check if user input auto-dispatches to a skill via its trigger pattern */
  matchTrigger(userInput: string): Skill | undefined {
    return this.visible().find(skill => triggerMatches(skill, userInput));
  }

  list(): Skill[] {
    return [...this.visible()];
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
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Failed to fetch skill: ${resp.status} ${resp.statusText}`);
    const content = await resp.text();

    const skill = parseSkillFile(content, url, false);
    if (!skill) throw new Error('Invalid skill file — missing or invalid frontmatter');

    const dir = path.join(aicoHome(), 'skills');
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
    // The run's project, not the process's directory: on a server those are
    // different places, and the process's was never read back.
    const root = scope === 'user'
      ? path.join(aicoHome(), 'skills')
      : path.join(currentCwd(), '.aico', 'skills');

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
    if (scope === 'project') {
      // A project's skill belongs to that project's runs only: re-read its
      // directory rather than merging it into every project's list.
      this._project.delete(projectKey(currentCwd()));
      await this.ensureProject();
      this._emit();
      return skill;
    }
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
