import { readFile, writeFile, mkdir } from 'fs/promises';
import path from 'path';
import os from 'os';
import type { Skill } from './types.js';
import { loadAllSkills, parseSkillFile } from './loader.js';
import { resolveSkillRef } from './resolver.js';

type SubscriberFn = (skills: Skill[]) => void;

export class SkillRegistry {
  private _skills: Skill[] = [];
  private _subscribers: SubscriberFn[] = [];
  private _opts: { disableBuiltins?: boolean; extraDirs?: string[] } = {};

  async load(opts: { disableBuiltins?: boolean; extraDirs?: string[] } = {}): Promise<void> {
    this._opts = opts;

    // Always include ~/.aico/skills/ as a default user dir
    const userSkillsDir = path.join(os.homedir(), '.aico', 'skills');
    const dirs = [userSkillsDir, ...(opts.extraDirs ?? [])];

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
    const filePath = path.join(dir, `${skill.frontmatter.name}.md`);
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
   */
  async addSkill(content: string, name: string, scope: 'user' | 'project' = 'user'): Promise<Skill> {
    const skill = parseSkillFile(content, `addSkill:${name}`, false);
    if (!skill) throw new Error('Invalid skill file — missing frontmatter (name + description required)');

    const dir = scope === 'user'
      ? path.join(os.homedir(), '.aico', 'skills')
      : path.join(process.cwd(), '.aico', 'skills');
    await mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${skill.frontmatter.name}.md`);
    await writeFile(filePath, content, 'utf8');

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
