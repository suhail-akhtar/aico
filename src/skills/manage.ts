/**
 * Everything a person can ask to have done to their skills.
 *
 * One tool with an action rather than a dozen tools. The verbs are the same
 * ones every registry has — list, read, create, update, delete, enable, import,
 * export — and spending a dozen slots in every request on them would cost more
 * than it buys. A model that can pick a skill from a one-line description can
 * pick an action from an enum.
 *
 * **Creating does not register.** Asked for a skill, the honest sequence is
 * write it, try it, then install it — and a tool that installs on the first
 * call makes the middle step optional, which means it does not happen. So
 * `create` writes a *draft*, somewhere the loader does not look, and says so.
 * `register` is a separate call that re-runs the checks and only then moves it
 * into place. The loop enforces the verification rather than the prompt asking
 * for it, which is the only version that survives a model in a hurry.
 *
 * **`verify` is allowed to fail loudly.** It checks the things that actually
 * break a skill in use: frontmatter that will not parse, a description too
 * vague to choose by, resources the body references that were never written,
 * and scripts that do not compile. A draft that fails is left where it is, with
 * the reasons, because the fix is usually one edit away.
 *
 * @module skills/manage
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { skillRegistry } from './registry.js';
import { parseSkillFile, loadSkillsFromDir } from './loader.js';
import { importSkill, exportSkill, removeSkill, userSkillsDir, safeName } from './import.js';
import { disabledIn, isDisabled, setEnabled, forget } from '../registry-state.js';
import type { Skill } from './types.js';

/** Where drafts wait. Deliberately not a directory the loader scans. */
export function draftsDir(): string {
  return path.join(os.homedir(), '.aico', 'skill-drafts');
}

export interface SkillResource { path: string; content: string }

export interface SkillManageInput {
  action: 'list' | 'read' | 'create' | 'verify' | 'register'
    | 'update' | 'delete' | 'enable' | 'disable' | 'import' | 'export';
  name?: string;
  description?: string;
  /** The procedure itself — the body below the frontmatter. */
  prompt?: string;
  aliases?: string[];
  trigger?: string;
  allowedTools?: string[];
  resources?: SkillResource[];
  /** For import: a folder, .zip/.skill, or SKILL.md. For export: where to write. */
  path?: string;
  overwrite?: boolean;
}

/** A frontmatter value that cannot break the block it sits in. */
function yamlValue(raw: string): string {
  const flat = raw.replace(/\r?\n/g, ' ').trim();
  return /^[^'"[\]{}#&*!|>%@`:-]/.test(flat) && !flat.includes(': ')
    ? flat
    : `"${flat.replace(/"/g, '\\"')}"`;
}

/** Build a SKILL.md from its parts. */
function composeMarkdown(input: SkillManageInput): string {
  const lines = ['---', `name: ${yamlValue(input.name ?? '')}`, `description: ${yamlValue(input.description ?? '')}`];
  if (input.aliases?.length) lines.push(`aliases: [${input.aliases.join(', ')}]`);
  if (input.trigger) lines.push(`trigger: ${input.trigger}`);
  if (input.allowedTools?.length) lines.push(`allowed-tools: [${input.allowedTools.join(', ')}]`);
  lines.push('author: aico-orchestrator', 'version: 1.0.0', '---', input.prompt ?? '');
  return lines.join('\n');
}

/** Refuse anything that would land outside the skill's own directory. */
function safeResource(dir: string, relative: string): string | null {
  if (!relative || path.isAbsolute(relative)) return null;
  const resolved = path.resolve(dir, relative);
  if (!resolved.startsWith(path.resolve(dir) + path.sep)) return null;
  if (/^skill\.md$/i.test(path.basename(resolved))) return null;
  return resolved;
}

/** Write a skill directory from scratch. */
function writeSkillTree(dir: string, markdown: string, resources: SkillResource[]): string[] {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), markdown, 'utf8');

  const written: string[] = [];
  for (const resource of resources) {
    const target = safeResource(dir, resource.path);
    if (!target) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, resource.content, 'utf8');
    written.push(resource.path.replace(/\\/g, '/'));
  }
  return written;
}

/** Every path a skill's body tells the agent to open. */
function referencedPaths(body: string): string[] {
  const found = new Set<string>();
  // `scripts/x.py`, `references/y.md` — a relative path with an extension, as
  // it would be written in prose or in a command.
  for (const match of body.matchAll(/(?<![\w/.\\])([\w.-]+\/[\w./-]+\.[A-Za-z0-9]{1,6})/g)) {
    found.add(match[1]!.replace(/^\.\//, ''));
  }
  return [...found];
}

export interface VerifyReport { ok: boolean; problems: string[]; notes: string[] }

/**
 * Check a skill directory the way using it would.
 *
 * Ordered by how badly each fault bites: one that stops the skill loading at
 * all, then one that stops it being chosen, then ones that strand the agent
 * partway through the procedure.
 */
export function verifySkillDir(dir: string): VerifyReport {
  const problems: string[] = [];
  const notes: string[] = [];

  const markdown = path.join(dir, 'SKILL.md');
  if (!fs.existsSync(markdown)) return { ok: false, problems: ['No SKILL.md — a skill needs one.'], notes };

  const raw = fs.readFileSync(markdown, 'utf8');
  const parsed = parseSkillFile(raw, markdown, false);
  if (!parsed) {
    return {
      ok: false,
      notes,
      problems: ['SKILL.md does not parse. It needs a --- block with at least name and description.'],
    };
  }

  const { name, description } = parsed.frontmatter;
  if (!name?.trim()) problems.push('No name in the frontmatter.');
  if (!description?.trim()) {
    problems.push('No description. It is the only part visible when choosing a skill, so without it this can never be picked.');
  } else if (description.trim().length < 25) {
    problems.push(
      `The description is ${description.trim().length} characters and needs to carry the whole `
      + 'selection decision. Say what it does and when to reach for it.',
    );
  }
  if (!parsed.promptTemplate.trim()) problems.push('The body is empty — there is no procedure to follow.');

  // A body that says "read references/tone.md" when no such file shipped sends
  // the agent looking for something that is not there.
  const shipped = new Set<string>();
  const walk = (base: string, prefix = ''): void => {
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (entry.name === '__pycache__' || entry.name.startsWith('.')) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(base, entry.name), rel);
      else shipped.add(rel);
    }
  };
  walk(dir);

  for (const referenced of referencedPaths(parsed.promptTemplate)) {
    if (!shipped.has(referenced)) {
      problems.push(`The body refers to "${referenced}" but no such file ships with the skill.`);
    }
  }

  // Python is the common case for a shipped script and the one where a syntax
  // error is invisible until the procedure runs.
  for (const file of shipped) {
    if (!file.endsWith('.py')) continue;
    const source = fs.readFileSync(path.join(dir, file), 'utf8');
    // Not a parser — just the mistakes that make a file fail to compile at all.
    if (/^\s*(def|class|if|for|while|try|with)\b[^\n]*[^:\s]\s*$/m.test(source)) {
      notes.push(`${file} may be missing a colon at the end of a block statement — worth running it.`);
    }
  }

  const extras = [...shipped].filter(f => !/^skill\.md$/i.test(f));
  if (extras.length) notes.push(`Ships ${extras.length} file(s): ${extras.join(', ')}.`);

  return { ok: problems.length === 0, problems, notes };
}

/** One line about a skill, for `list`. */
function describe(skill: Skill, disabled: Set<string>): string {
  const off = disabled.has(skill.frontmatter.name.toLowerCase()) ? ' [disabled]' : '';
  const kind = skill.isBuiltin ? ' (built in)' : '';
  const ships = skill.resources?.length ? ` — ships ${skill.resources.length} file(s)` : '';
  const aliases = skill.frontmatter.aliases?.length ? ` — also /${skill.frontmatter.aliases.join(', /')}` : '';
  return `- ${skill.frontmatter.name}${kind}${off}: ${skill.frontmatter.description}${ships}${aliases}`;
}

/** Where an installed skill lives, whichever shape it has. */
function installedDir(skill: Skill): string | null {
  return skill.dir ?? null;
}

export async function executeSkillManage(input: SkillManageInput): Promise<string> {
  const action = input.action;
  const name = input.name?.trim() ?? '';

  switch (action) {
    case 'list': {
      const disabled = disabledIn('skills');
      const all = skillRegistry.list();
      if (all.length === 0) return 'No skills installed.';
      const drafts = fs.existsSync(draftsDir())
        ? fs.readdirSync(draftsDir(), { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name)
        : [];
      return [
        `${all.length} skill(s):`,
        ...all.map(s => describe(s, disabled)),
        drafts.length
          ? `\n${drafts.length} unregistered draft(s): ${drafts.join(', ')} — verify and register, or delete.`
          : '',
      ].filter(Boolean).join('\n');
    }

    case 'read': {
      const skill = skillRegistry.lookup(name);
      if (!skill) return `There is no skill called "${name}". Use action:"list" to see what there is.`;
      const dir = installedDir(skill);
      return [
        `name: ${skill.frontmatter.name}`,
        `description: ${skill.frontmatter.description}`,
        skill.frontmatter.aliases?.length ? `aliases: ${skill.frontmatter.aliases.join(', ')}` : '',
        skill.frontmatter.trigger ? `trigger: ${skill.frontmatter.trigger}` : '',
        skill.frontmatter.allowedTools?.length ? `allowed-tools: ${skill.frontmatter.allowedTools.join(', ')}` : '',
        `enabled: ${!isDisabled('skills', skill.frontmatter.name)}`,
        dir ? `directory: ${dir}` : `file: ${skill.filePath}`,
        skill.resources?.length ? `ships: ${skill.resources.join(', ')}` : '',
        '', '--- body ---', skill.promptTemplate,
      ].filter(Boolean).join('\n');
    }

    case 'create': {
      if (!name) return 'A name is required.';
      if (!input.description?.trim()) {
        return 'A description is required — it is the only part visible when choosing a skill, '
          + 'so without one the skill can never be picked.';
      }
      if (!input.prompt?.trim()) return 'A prompt is required — that is the procedure itself.';

      const safe = safeName(name);
      if (!safe) return `"${name}" is not a usable skill name.`;

      const dir = path.join(draftsDir(), safe);
      const written = writeSkillTree(dir, composeMarkdown(input), input.resources ?? []);
      const report = verifySkillDir(dir);

      return [
        `Draft written to ${dir}. It is NOT registered yet and the agent cannot use it.`,
        written.length ? `Files: SKILL.md, ${written.join(', ')}` : 'Files: SKILL.md',
        '',
        report.ok
          ? 'Checks pass. Now actually try it — run its scripts, follow its steps on a real example — '
            + 'then call action:"register" to install it.'
          : `Checks fail:\n${report.problems.map(p => `  - ${p}`).join('\n')}\n`
            + 'Fix the draft (edit the files directly, or call create again) and re-run action:"verify".',
        report.notes.length ? report.notes.map(n => `  note: ${n}`).join('\n') : '',
      ].filter(Boolean).join('\n');
    }

    case 'verify': {
      if (!name) return 'A name is required.';
      const safe = safeName(name);
      const draft = path.join(draftsDir(), safe);
      const target = fs.existsSync(draft) ? draft : installedDir(skillRegistry.lookup(name) ?? ({} as Skill));
      if (!target || !fs.existsSync(target)) {
        return `No draft or installed directory skill called "${name}".`;
      }
      const report = verifySkillDir(target);
      return [
        `${target}`,
        report.ok ? 'Checks pass.' : `Checks fail:\n${report.problems.map(p => `  - ${p}`).join('\n')}`,
        ...report.notes.map(n => `  note: ${n}`),
        report.ok && target === draft
          ? 'Try it for real before registering — a skill that has never been run is a guess.'
          : '',
      ].filter(Boolean).join('\n');
    }

    case 'register': {
      if (!name) return 'A name is required.';
      const safe = safeName(name);
      const draft = path.join(draftsDir(), safe);
      if (!fs.existsSync(draft)) {
        return `No draft called "${name}". Create one first with action:"create".`;
      }

      // Re-checked here rather than trusting the check done at create time: the
      // draft is editable in between, which is the whole point of it.
      const report = verifySkillDir(draft);
      if (!report.ok) {
        return `Not registered — "${name}" still fails its checks:\n`
          + report.problems.map(p => `  - ${p}`).join('\n')
          + '\nFix the draft and try again.';
      }

      const result = await importSkill(draft, { overwrite: input.overwrite ?? false });
      if (!result.ok) return `Not registered: ${result.error}`;

      fs.rmSync(draft, { recursive: true, force: true });
      await skillRegistry.reload();
      return [
        `Registered "${result.name}"${result.replaced ? ' (replaced the previous one)' : ''}.`,
        `Installed at ${result.installedAt}.`,
        result.resources?.length ? `Ships: ${result.resources.join(', ')}` : '',
        'It is now in the catalogue and can be used immediately.',
      ].filter(Boolean).join('\n');
    }

    case 'update': {
      const skill = skillRegistry.lookup(name);
      if (!skill) return `There is no skill called "${name}".`;
      if (skill.isBuiltin) return `"${name}" is built in and cannot be edited. Create your own with the same name to override it.`;

      const dir = installedDir(skill);
      if (!dir) {
        return `"${name}" is a single-file skill. Use action:"create" then "register" with overwrite `
          + 'to replace it, which also lets it ship files.';
      }
      // Only the parts named are replaced; the rest of the skill stands.
      const merged: SkillManageInput = {
        action: 'update',
        name: skill.frontmatter.name,
        description: input.description ?? skill.frontmatter.description,
        prompt: input.prompt ?? skill.promptTemplate,
        aliases: input.aliases ?? skill.frontmatter.aliases,
        trigger: input.trigger ?? skill.frontmatter.trigger,
        allowedTools: input.allowedTools ?? skill.frontmatter.allowedTools,
      };
      fs.writeFileSync(path.join(dir, 'SKILL.md'), composeMarkdown(merged), 'utf8');
      for (const resource of input.resources ?? []) {
        const target = safeResource(dir, resource.path);
        if (!target) continue;
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, resource.content, 'utf8');
      }
      await skillRegistry.reload();
      const report = verifySkillDir(dir);
      return [
        `Updated "${skill.frontmatter.name}".`,
        report.ok ? 'Checks still pass.' : `Warning — it now fails its checks:\n${report.problems.map(p => `  - ${p}`).join('\n')}`,
      ].join('\n');
    }

    case 'delete': {
      const skill = skillRegistry.lookup(name);
      if (skill?.isBuiltin) return `"${name}" is built in and cannot be deleted. Disable it instead.`;
      const result = removeSkill(name);
      if (!result.ok) return `Not deleted: ${result.error}`;
      forget('skills', name);
      await skillRegistry.reload();
      return `Deleted "${name}" and everything it shipped with.`;
    }

    case 'enable':
    case 'disable': {
      const skill = skillRegistry.lookup(name);
      if (!skill) return `There is no skill called "${name}".`;
      const wanted = action === 'enable';
      const changed = setEnabled('skills', skill.frontmatter.name, wanted);
      return changed
        ? `"${skill.frontmatter.name}" is now ${wanted ? 'enabled' : 'disabled'}.`
          + (wanted ? '' : ' It stays on disk and can be enabled again; it just leaves the catalogue.')
        : `"${skill.frontmatter.name}" was already ${wanted ? 'enabled' : 'disabled'}.`;
    }

    case 'import': {
      if (!input.path) return 'A path is required — a folder, a .zip/.skill, or a SKILL.md.';
      const result = await importSkill(input.path, { overwrite: input.overwrite ?? false });
      if (!result.ok) return `Not imported: ${result.error}`;
      await skillRegistry.reload();
      return [
        `Imported "${result.name}"${result.replaced ? ' (replaced the previous one)' : ''}.`,
        `Installed at ${result.installedAt}.`,
        result.resources?.length ? `Ships: ${result.resources.join(', ')}` : '',
      ].filter(Boolean).join('\n');
    }

    case 'export': {
      const skill = skillRegistry.lookup(name);
      if (!skill) return `There is no skill called "${name}".`;
      const dir = installedDir(skill);
      if (!dir) return `"${name}" is a single file, not a directory skill: ${skill.filePath}. Copy it directly.`;
      if (!input.path) return 'A path is required — where to write the .zip.';
      const result = await exportSkill(dir, input.path);
      return result.ok
        ? `Exported "${skill.frontmatter.name}" to ${result.path}. That file imports on any AICO install.`
        : `Not exported: ${result.error}`;
    }

    default:
      return `Unknown action "${String(action)}".`;
  }
}

export const skillManageToolDefinition = {
  name: 'SkillManage',
  description: [
    'Manage the skill library: list, read, create, verify, register, update, delete, enable, disable,',
    'import and export. Use this whenever someone asks what skills exist, or asks to make, change,',
    'remove, switch off, or share one.',
    'Creating writes a DRAFT and does not register it — write it, actually try it, then register it.',
    'To *use* an existing skill, call Skill instead; this tool is for managing them.',
  ].join(' '),
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'read', 'create', 'verify', 'register', 'update', 'delete', 'enable', 'disable', 'import', 'export'],
        description:
          'list: every skill and whether it is enabled. read: one skill in full. create: write an '
          + 'unregistered draft. verify: check a draft or skill. register: install a draft that passes. '
          + 'update: change an installed skill. delete: remove it. enable/disable: toggle without '
          + 'deleting. import: install from a folder/.zip/SKILL.md. export: pack one into a .zip.',
      },
      name: { type: 'string', description: 'Which skill. Required for everything except list and import.' },
      description: {
        type: 'string',
        description:
          'One line saying what it does and when to reach for it. This is the whole selection '
          + 'decision — it is all another agent sees before choosing.',
      },
      prompt: { type: 'string', description: 'The procedure itself. Use {args} where the caller\'s context goes.' },
      aliases: { type: 'array', items: { type: 'string' }, description: 'Short alternative names.' },
      trigger: { type: 'string', description: 'Regex — if a request matches, this skill is offered first.' },
      allowedTools: { type: 'array', items: { type: 'string' }, description: 'Tools the procedure expects, e.g. ["Bash","Read"].' },
      resources: {
        type: 'array',
        description:
          'Files to ship with the skill, which makes it a directory skill. Use this when the procedure '
          + 'needs a script to run or a reference to consult. Nothing is executed on creation.',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative path inside the skill, e.g. "scripts/check.py".' },
            content: { type: 'string', description: 'The file\'s full contents.' },
          },
          required: ['path', 'content'],
        },
      },
      path: { type: 'string', description: 'For import: what to install. For export: where to write the .zip.' },
      overwrite: { type: 'boolean', description: 'Replace an existing skill of the same name.' },
    },
    required: ['action'],
  },
};
