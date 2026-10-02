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
import { aicoHome } from '../home.js';
import { skillRegistry } from './registry.js';
import { parseSkillFile, loadSkillsFromDir } from './loader.js';
import {
  importSkill, exportSkill, removeSkill, safeName, stageImport, installStaged, reviewInstalled,
  type ImportReview, type ReviewedSkill,
} from './import.js';
import { parseFrontmatter, updateFrontmatter, type FmValue } from './frontmatter.js';
import { validateFrontmatter } from './validate.js';
import { markReviewed, treeHash } from './provenance.js';
import { hasEvals, readDraftEvals } from './eval/evals-file.js';
import { readReport, evalGate, describeReport, type SkillEvalReport } from './eval/report.js';
import { disabledIn, isDisabled, setEnabled, forget } from '../registry-state.js';
import { currentCwd, currentRunContext } from '../run-context.js';
import { loadSettings } from '../settings.js';
import type { Skill } from './types.js';

/** Where drafts wait. Deliberately not a directory the loader scans. */
export function draftsDir(): string {
  return path.join(aicoHome(), 'skill-drafts');
}

export interface SkillResource { path: string; content: string }

export interface SkillManageInput {
  action: 'list' | 'read' | 'create' | 'verify' | 'validate' | 'register'
    | 'update' | 'delete' | 'enable' | 'disable' | 'import' | 'review' | 'install' | 'export' | 'eval';
  /** For eval: the spending ceiling in USD (default 0.25, never above 2). */
  budget?: number;
  /** For eval: also run each task without the skill (default true). */
  baseline?: boolean;
  /** For eval: score and tune the description on the trigger queries (default true). */
  triggers?: boolean;
  /** For eval: description revisions to try (default 1, 0–3). */
  descriptionRounds?: number;
  /** For eval: times to re-score the final description on held-out queries (default 1). */
  triggerRuns?: number;
  name?: string;
  description?: string;
  /** The procedure itself — the body below the frontmatter. */
  prompt?: string;
  aliases?: string[];
  trigger?: string;
  /** Not in the tool schema; carried so an update keeps a hand-written one. */
  antiTrigger?: string;
  allowedTools?: string[];
  resources?: SkillResource[];
  /** For import/review: a folder, pack, plugin, .zip/.skill, or SKILL.md. For export: where to write. */
  path?: string;
  overwrite?: boolean;
  /** For install: the staged import's id (from review). */
  id?: string;
  /** For install: which of the staged skills, by name (default: every valid one). */
  select?: string[];
  /** For install/import: enable as reviewed. Honoured only with a person's yes (`ctx.human`). */
  enable?: boolean;
  /** For export: keep a root-level evals/ folder (AICO users can run them; Claude ignores it). */
  includeEvals?: boolean;
  /**
   * Where `register` installs: the user's skills (default) or the current
   * run's project (`<project>/.aico/skills`). `create` records it in the draft,
   * with the project, so a later `register` installs where it was meant to.
   */
  scope?: 'user' | 'project';
}

/** Beside a draft: where it is meant to be installed. Dot-named, so it never ships. */
const DRAFT_META = '.aico-draft.json';

interface DraftMeta { scope: 'user' | 'project'; project?: string }

function readDraftMeta(dir: string): DraftMeta | undefined {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, DRAFT_META), 'utf8')) as DraftMeta;
    return meta.scope === 'project' || meta.scope === 'user' ? meta : undefined;
  } catch {
    return undefined;
  }
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
  if (input.antiTrigger) lines.push(`antiTrigger: ${input.antiTrigger}`);
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

  // The spec's own rules (name, lengths, XML, metadata), held to the letter:
  // what `verify` passes, Claude's validator should pass too.
  const fm = parseFrontmatter(raw);
  const spec = validateFrontmatter(fm.data, { dirName: path.basename(dir), body: fm.body, strict: true });
  problems.push(...fm.errors.map(e => `frontmatter ${e}`), ...spec.errors);
  notes.push(...spec.warnings.filter(w => !/^the folder is/.test(w) || !/skill-drafts/.test(dir)));

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

  // The skill's own evals (Phase 5): a file that will not parse would only
  // surface when someone paid to run it.
  const evals = readDraftEvals(dir, parsed.frontmatter.name);
  if (evals) {
    problems.push(...evals.problems.map(p => `evals: ${p}`));
    notes.push(...evals.notes.map(n => `evals: ${n}`));
    const report = readReport(dir);
    notes.push(!report
      ? 'evals: not measured yet — action:"eval" runs them with and without the skill.'
      : report.hash === treeHash(dir)
        ? `evals: measured ${report.at.slice(0, 10)}${report.uplift !== undefined ? `, uplift ${report.uplift >= 0 ? '+' : ''}${report.uplift.toFixed(2)}` : ''}${report.complete ? '' : ' (incomplete)'}.`
        : 'evals: the files changed since they were measured — measure again before registering.');
  }

  return { ok: problems.length === 0, problems, notes };
}

/**
 * Who is asking. `human` is true only when the caller proved a person is
 * behind this request — the decision gate on the HTTP route (a desktop host
 * grant, the web UI key or its client nonce). The model's own tool calls
 * never carry it, and neither does the API token alone.
 */
export interface SkillManageContext { human?: boolean }

/** A review, in words, for the model or the terminal. */
export function describeReview(review: ImportReview): string {
  const lines = [
    `Staged import ${review.id} — ${review.sourceKind} from ${review.source}`
      + (review.sourceSha256 ? ` (sha256 ${review.sourceSha256.slice(0, 16)}…)` : ''),
    `${review.skills.length} skill(s) found. Nothing is installed yet and nothing was run.`,
  ];
  for (const s of review.skills) lines.push('', ...describeReviewed(s));
  if (review.notes.length) lines.push('', ...review.notes.map(n => `note: ${n}`));
  return lines.join('\n');
}

export function describeReviewed(s: ReviewedSkill): string[] {
  const out = [`■ ${s.name}${s.exists ? (s.exists.builtin ? ' (replaces a built-in skill)' : ' (a skill with this name is installed)') : ''}`,
    `  ${s.description || '(no description)'}`,
    `  ${s.files.length} file(s); ~${s.tokens.catalogue} tokens in the catalogue, ~${s.tokens.body} when opened; sha256 ${s.sha256.slice(0, 16)}…`];
  if (s.scripts.length) out.push(`  scripts: ${s.scripts.map(x => `${x.file} (${x.interpreter})`).join(', ')}`);
  for (const e of s.errors) out.push(`  ERROR: ${e}`);
  for (const w of s.warnings) out.push(`  warning: ${w}`);
  const notable = s.findings.filter(f => f.severity !== 'info');
  for (const f of notable.slice(0, 15)) out.push(`  ${f.severity === 'high' ? 'HIGH' : 'check'}: ${f.file}${f.line ? `:${f.line}` : ''} ${f.message}`);
  if (notable.length > 15) out.push(`  …and ${notable.length - 15} more finding(s).`);
  return out;
}

/** The refusal the model gets when it tries to enable what a person has not reviewed. */
function needsPerson(name: string, reason?: string): string {
  return `Not enabled: "${name}" was imported and ${reason ?? 'has not been reviewed'}. `
    + 'An imported skill reaches the model only after a person reviews it: ask them to open '
    + 'Settings → Skills, look at its files and scan findings, and choose "Review and enable". '
    + 'You cannot enable it yourself, and the API token cannot either.';
}

/** One line about a skill, for `list`. */
function describe(skill: Skill, disabled: Set<string>): string {
  const off = disabled.has(skill.frontmatter.name.toLowerCase()) ? ' [disabled]' : '';
  const unreviewed = skill.trust === 'unreviewed' ? ` [unreviewed — ${skill.trustReason ?? 'needs a person to review it'}; not usable]` : '';
  const kind = skill.isBuiltin ? ' (built in)' : '';
  const ships = skill.resources?.length ? ` — ships ${skill.resources.length} file(s)` : '';
  const aliases = skill.frontmatter.aliases?.length ? ` — also /${skill.frontmatter.aliases.join(', /')}` : '';
  return `- ${skill.frontmatter.name}${kind}${off}${unreviewed}: ${skill.frontmatter.description}${ships}${aliases}`;
}

/** Where an installed skill lives, whichever shape it has. */
function installedDir(skill: Skill): string | null {
  return skill.dir ?? null;
}

export async function executeSkillManage(input: SkillManageInput, ctx: SkillManageContext = {}): Promise<string> {
  const action = input.action === 'validate' ? 'verify' : input.action;
  const name = input.name?.trim() ?? '';

  switch (action) {
    case 'list': {
      const disabled = disabledIn('skills');
      const all = skillRegistry.listAll();
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
      const skill = skillRegistry.lookupAny(name);
      if (!skill) return `There is no skill called "${name}". Use action:"list" to see what there is.`;
      const dir = installedDir(skill);
      return [
        `name: ${skill.frontmatter.name}`,
        `description: ${skill.frontmatter.description}`,
        skill.frontmatter.aliases?.length ? `aliases: ${skill.frontmatter.aliases.join(', ')}` : '',
        skill.frontmatter.trigger ? `trigger: ${skill.frontmatter.trigger}` : '',
        skill.frontmatter.allowedTools?.length ? `allowed-tools: ${skill.frontmatter.allowedTools.join(', ')}` : '',
        `enabled: ${!isDisabled('skills', skill.frontmatter.name)}`,
        `trust: ${skill.trust ?? 'authored'}${skill.trustReason ? ` (${skill.trustReason})` : ''}`,
        skill.provenance ? `source: ${skill.provenance.source} (${skill.provenance.sourceKind}, imported ${skill.provenance.importedAt})` : '',
        ...(skill.warnings ?? []).map(w => `warning: ${w}`),
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
      if (input.scope === 'project') {
        const meta: DraftMeta = { scope: 'project', project: currentCwd() };
        fs.writeFileSync(path.join(dir, DRAFT_META), JSON.stringify(meta, null, 2), 'utf8');
      }
      const report = verifySkillDir(dir);

      return [
        `Draft written to ${dir}. It is NOT registered yet and the agent cannot use it.`
          + (input.scope === 'project' ? ` Registering installs it in ${path.join(currentCwd(), '.aico', 'skills')}.` : ''),
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
      const target = fs.existsSync(draft) ? draft : installedDir(skillRegistry.lookupAny(name) ?? ({} as Skill));
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

      // Measured before accepted (Phase 5): a draft with evals registers only
      // on a report for exactly these files; one that did not beat the
      // no-skill baseline needs a person, not the model, to go ahead.
      const gate = evalGate(draft, hasEvals(draft));
      if (!gate.ok && !(gate.person && ctx.human)) {
        return `Not registered — "${name}": ${gate.reason}`
          + (gate.report ? `\n\n${describeReport(gate.report)}` : '');
      }
      const measured: SkillEvalReport | undefined = gate.report;

      // A project draft installs in the project it was drafted for, whichever
      // directory registers it; an explicit scope on this call wins.
      const meta = readDraftMeta(draft);
      const scope = input.scope ?? meta?.scope ?? 'user';
      const project = meta?.project ?? currentCwd();
      const targetDir = scope === 'project' ? path.join(project, '.aico', 'skills') : undefined;
      const result = await importSkill(draft, {
        overwrite: input.overwrite ?? false,
        ...(targetDir ? { targetDir } : {}),
      });
      if (!result.ok) return `Not registered: ${result.error}`;
      if (result.installedAt) fs.rmSync(path.join(result.installedAt, DRAFT_META), { force: true });

      fs.rmSync(draft, { recursive: true, force: true });
      await skillRegistry.reload();
      return [
        `Registered "${result.name}"${result.replaced ? ' (replaced the previous one)' : ''}.`,
        `Installed at ${result.installedAt}.`,
        result.resources?.length ? `Ships: ${result.resources.join(', ')}` : '',
        measured?.uplift !== undefined
          ? `Measured: ${measured.withMean!.toFixed(2)} with vs ${measured.withoutMean!.toFixed(2)} without (uplift ${measured.uplift >= 0 ? '+' : ''}${measured.uplift.toFixed(2)})`
            + `${measured.triggers ? `; trigger precision ${measured.triggers.heldOut[0]!.precision?.toFixed(2) ?? 'n/a'} held out` : ''}.`
          : '',
        'It is now in the catalogue and can be used immediately.',
      ].filter(Boolean).join('\n');
    }

    case 'update': {
      const skill = skillRegistry.lookupAny(name);
      if (!skill) return `There is no skill called "${name}".`;
      if (skill.isBuiltin) return `"${name}" is built in and cannot be edited. Create your own with the same name to override it.`;

      const dir = installedDir(skill);
      if (!dir) {
        return `"${name}" is a single-file skill. Use action:"create" then "register" with overwrite `
          + 'to replace it, which also lets it ship files.';
      }
      // Only the parts named are replaced; the rest of the skill — including
      // keys AICO does not use, comments, and the body — stands as written.
      const file = path.join(dir, 'SKILL.md');
      const current = fs.readFileSync(file, 'utf8');
      const patch: Record<string, FmValue | undefined> = {};
      if (input.description !== undefined) patch.description = input.description.replace(/\r?\n/g, ' ').trim();
      if (input.aliases !== undefined) patch.aliases = input.aliases;
      if (input.trigger !== undefined) patch.trigger = input.trigger;
      if (input.allowedTools !== undefined) {
        const existing = parseFrontmatter(current).data;
        patch[existing.allowedTools !== undefined ? 'allowedTools' : 'allowed-tools'] = input.allowedTools;
      }
      let text = updateFrontmatter(current, patch);
      if (input.prompt !== undefined) {
        const head = /^---\n[\s\S]*?\n---/.exec(text)![0];
        text = `${head}\n${input.prompt}`;
      }
      fs.writeFileSync(file, text, 'utf8');
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
      const skill = skillRegistry.lookupAny(name);
      if (skill?.isBuiltin) return `"${name}" is built in and cannot be deleted. Disable it instead.`;
      // Wherever it is installed — a project skill lives in its project.
      const root = skill?.dir ? path.dirname(skill.dir) : skill?.filePath ? path.dirname(skill.filePath) : undefined;
      const result = root ? removeSkill(skill?.frontmatter.name ?? name, root) : removeSkill(name);
      if (!result.ok) return `Not deleted: ${result.error}`;
      forget('skills', name);
      await skillRegistry.reload();
      return `Deleted "${name}" and everything it shipped with.`;
    }

    case 'enable':
    case 'disable': {
      const skill = skillRegistry.lookupAny(name);
      if (!skill) return `There is no skill called "${name}".`;
      const wanted = action === 'enable';
      if (wanted && skill.trust === 'unreviewed') {
        // The review gate (design §5.1): enabling an imported skill is the
        // human review. Only a caller that proved a person is present may.
        if (!ctx.human || !skill.dir) return needsPerson(skill.frontmatter.name, skill.trustReason);
        markReviewed(skill.dir);
        setEnabled('skills', skill.frontmatter.name, true);
        await skillRegistry.reload();
        return `"${skill.frontmatter.name}" is reviewed and enabled. It is in the catalogue now.`;
      }
      const changed = setEnabled('skills', skill.frontmatter.name, wanted);
      return changed
        ? `"${skill.frontmatter.name}" is now ${wanted ? 'enabled' : 'disabled'}.`
          + (wanted ? '' : ' It stays on disk and can be enabled again; it just leaves the catalogue.')
        : `"${skill.frontmatter.name}" was already ${wanted ? 'enabled' : 'disabled'}.`;
    }

    case 'review': {
      // Read-only: a staged import, or an installed skill's own review.
      if (input.path) {
        const review = await stageImport({ path: input.path });
        if ('error' in review) return `Not staged: ${review.error}`;
        return `${describeReview(review)}\n\nTo install: action:"install" with id:"${review.id}". `
          + 'It installs as unreviewed — a person enables it after reading this review.';
      }
      if (!name) return 'A path (to stage an import) or a name (to review an installed skill) is required.';
      const skill = skillRegistry.lookupAny(name);
      if (!skill?.dir) return `There is no installed directory skill called "${name}".`;
      const r = reviewInstalled(skill.dir);
      return [`${skill.frontmatter.name} — trust: ${skill.trust ?? 'authored'}${skill.trustReason ? ` (${skill.trustReason})` : ''}`,
        r.provenance ? `source: ${r.provenance.source}` : '', ...describeReviewed(r)].filter(Boolean).join('\n');
    }

    case 'install': {
      if (!input.id) return 'An id is required — the one action:"review" returned.';
      const trust = input.enable && ctx.human ? 'reviewed' : 'unreviewed';
      const out = installStaged(input.id, {
        trust, overwrite: input.overwrite ?? false,
        ...(input.select?.length ? { select: input.select } : {}),
      });
      if (out.error) return `Not installed: ${out.error}`;
      await skillRegistry.reload();
      if (trust === 'reviewed') for (const s of out.installed) setEnabled('skills', s.name, true);
      return [
        out.installed.length
          ? `Installed ${out.installed.map(s => `"${s.name}"${s.replaced ? ' (replaced)' : ''}`).join(', ')} as ${trust}.`
          : 'Not installed: nothing was installed.',
        ...out.skipped.map(s => `  skipped ${s.name}: ${s.reason}`),
        trust === 'unreviewed' && out.installed.length
          ? 'They are on disk but not usable until a person reviews and enables them in Settings → Skills.'
          : '',
      ].filter(Boolean).join('\n');
    }

    case 'import': {
      // The model's import: staged, reviewed in words, installed unreviewed.
      // Enabling is a person's decision (design §5.1 import, item 4).
      if (!input.path) return 'A path is required — a folder, a pack, a plugin, a .skill/.zip, or a SKILL.md.';
      const review = await stageImport({ path: input.path });
      if ('error' in review) return `Not imported: ${review.error}`;
      const trust = input.enable && ctx.human ? 'reviewed' : 'unreviewed';
      const out = installStaged(review.id, { trust, overwrite: input.overwrite ?? false });
      await skillRegistry.reload();
      if (trust === 'reviewed') for (const s of out.installed) setEnabled('skills', s.name, true);
      if (!out.installed.length) {
        return `Not imported: ${out.skipped.map(s => `${s.name} — ${s.reason}`).join('; ') || 'nothing installable was found'}`;
      }
      return [
        `Imported ${out.installed.map(s => `"${s.name}"${s.replaced ? ' (replaced the previous one)' : ''}`).join(', ')}.`,
        ...out.installed.map(s => `Installed at ${s.installedAt}.`),
        ...out.skipped.map(s => `  skipped ${s.name}: ${s.reason}`),
        trust === 'unreviewed'
          ? 'Installed as UNREVIEWED: not in the catalogue, and Skill refuses it, until a person reviews and enables it in Settings → Skills.'
          : '',
        '', describeReview(review),
      ].join('\n');
    }

    case 'export': {
      const skill = skillRegistry.lookupAny(name);
      if (!skill) return `There is no skill called "${name}".`;
      const dir = installedDir(skill);
      if (!dir) return `"${name}" is a single file, not a directory skill: ${skill.filePath}. Copy it directly.`;
      if (!input.path) return 'A path is required — a folder, or a file ending .skill.';
      const result = await exportSkill(dir, input.path, { includeEvals: input.includeEvals ?? false });
      if (!result.ok) return result.error?.startsWith('Not ') ? result.error : `Not exported: ${result.error}`;
      return [
        `Exported "${skill.frontmatter.name}" to ${result.path} (${result.files} file(s)) in Claude's .skill format — it imports into Claude and into AICO.`,
        result.rewritten ? "AICO's own keys (trigger, aliases, …) were moved under metadata as aico-* so Claude's validator accepts the file." : '',
        ...(result.warnings ?? []).map(w => `warning: ${w}`),
      ].filter(Boolean).join('\n');
    }

    case 'eval': {
      // Measure a draft (or an installed skill of the user's) on its own
      // evals: with vs without the skill, and its triggering. Spends money,
      // inside a hard ceiling; the result is written beside the skill and is
      // what `register` checks.
      if (!name) return 'A name is required.';
      const draft = path.join(draftsDir(), safeName(name));
      const installed = skillRegistry.lookupAny(name);
      const target = fs.existsSync(draft) ? draft : installed && !installed.isBuiltin ? installedDir(installed) : null;
      if (!target) return `No draft or installed directory skill called "${name}" (built-in skills are measured with \`aico skill eval\`).`;
      const report = verifySkillDir(target);
      if (!report.ok) return `Not measured — fix its checks first:\n${report.problems.map(p => `  - ${p}`).join('\n')}`;
      if (!hasEvals(target)) {
        return `"${name}" has no evals/evals.json. Write at least three tasks with deterministic checks and ten trigger `
          + 'queries (see the skill-author skill), as resources of the draft, then measure.';
      }
      const run = currentRunContext();
      const settings = run?.settings ?? await loadSettings();
      const model = run?.model ?? settings.model;
      if (!model) return 'No model is configured to run the measurement with.';
      const { measureSkill } = await import('./eval/measure.js');
      // A deadline of its own, inside the tool's: no measurement runs forever.
      const signal = AbortSignal.timeout(15 * 60 * 1000);
      const out = await measureSkill(target, {
        model, settings, signal,
        ...(input.budget !== undefined ? { budgetUsd: input.budget } : {}),
        ...(input.baseline !== undefined ? { baseline: input.baseline } : {}),
        ...(input.triggers !== undefined ? { triggers: input.triggers } : {}),
        ...(input.descriptionRounds !== undefined ? { descriptionRounds: input.descriptionRounds } : {}),
        ...(input.triggerRuns !== undefined ? { triggerRuns: input.triggerRuns } : {}),
      });
      if ('error' in out) return `Not measured: ${out.error}`;
      const gate = evalGate(target, true);
      return [
        describeReport(out),
        '',
        gate.ok
          ? 'Show the person these results; registering is their call.'
          : `Register would refuse: ${gate.reason}`,
      ].join('\n');
    }

    default:
      return `Unknown action "${String(action)}".`;
  }
}

export const skillManageToolDefinition = {
  name: 'SkillManage',
  description: [
    'Manage the skill library: list, read, create, verify, register, update, delete, enable, disable,',
    'review, import, install and export. Use this whenever someone asks what skills exist, or asks to make, change,',
    'remove, switch off, bring in or share one.',
    'Imported skills install UNREVIEWED and stay unusable until a person reviews and enables them in Settings; you cannot enable them.',
    'Creating writes a DRAFT and does not register it — write it, actually try it, then register it.',
    'eval measures a draft that ships evals/evals.json with and without the skill (it spends money, within a ceiling); a draft with evals registers only after a fresh eval shows it helps.',
    'To *use* an existing skill, call Skill instead; this tool is for managing them.',
  ].join(' '),
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'read', 'create', 'verify', 'validate', 'register', 'update', 'delete', 'enable', 'disable', 'review', 'import', 'install', 'export', 'eval'],
        description:
          'list: every skill and whether it is enabled. read: one skill in full. create: write an '
          + 'unregistered draft. verify/validate: check a draft or skill against the spec. register: install a draft that passes. '
          + 'update: change an installed skill. delete: remove it. enable/disable: toggle without '
          + 'deleting. review: stage a folder/pack/plugin/.skill/SKILL.md (path) and report files, scripts and scan findings without installing, or review an installed skill (name). '
          + 'install: install a staged review (id, select) as unreviewed. import: review + install in one step. '
          + "export: pack one into Claude's .skill format. eval: run a draft's evals with and without it, score its triggering, tune its description.",
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
      path: { type: 'string', description: 'For review/import: what to bring in. For export: a folder, or a file ending .skill.' },
      id: { type: 'string', description: 'For install: the staged import id that review returned.' },
      select: { type: 'array', items: { type: 'string' }, description: 'For install: which skills of a pack to install (default all valid ones).' },
      includeEvals: { type: 'boolean', description: 'For export: keep the evals/ folder (Claude ignores it).' },
      overwrite: { type: 'boolean', description: 'Replace an existing skill of the same name.' },
      scope: { type: 'string', enum: ['user', 'project'], description: 'create/register: for you everywhere (default), or for this project only.' },
      budget: { type: 'number', description: 'For eval: spending ceiling in USD (default 0.25, at most 2).' },
      baseline: { type: 'boolean', description: 'For eval: also run each task without the skill (default true).' },
      triggers: { type: 'boolean', description: 'For eval: score and tune the description on the trigger queries (default true).' },
    },
    required: ['action'],
  },
};
