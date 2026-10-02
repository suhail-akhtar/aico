/**
 * The Agent Skills spec's rules, checked in one place.
 *
 * WHY. A skill that loads in AICO but fails Claude's validator is not
 * "compatible", it is "parses". The spec (agentskills.io/specification) and
 * Anthropic's additions are short and checkable: a name of 1–64 characters in
 * `a-z0-9-` with no leading, trailing or doubled hyphen that matches its
 * folder; a description of 1–1,024 characters; no XML tags in either; no
 * "anthropic" or "claude" in the name; `compatibility` ≤ 500 characters;
 * `metadata` a map of strings. Design §5.1 / F6.
 *
 * TWO STRICTNESSES. Something arriving from outside (import, export) is held
 * to the spec: errors block it. Something already installed is only warned
 * about — stricter rules must not make a skill someone has used for months
 * vanish on upgrade (design §10 Phase 1, risks). Either way every message
 * names the fix (§7.8): "description is 1,240 characters; the limit is 1,024
 * — move detail into the body", never "invalid".
 *
 * What it does not judge: whether the description is *good*. `verifySkillDir`
 * (skills/manage) keeps its usefulness checks — vague descriptions, missing
 * referenced files, Python that will not compile.
 *
 * @module skills/validate
 */

import type { FmMap } from './frontmatter.js';

export const NAME_MAX = 64;
export const DESCRIPTION_MAX = 1024;
/** claude.ai's own upload form is stricter than the spec (Help Center, 2026-10). */
export const DESCRIPTION_CLAUDE_AI = 200;
export const COMPATIBILITY_MAX = 500;
export const BODY_LINES_MAX = 500;

/** Keys claude.ai's validator accepts at the top level; anything else warns on export. */
export const CLAUDE_AI_KEYS = new Set(['name', 'description', 'license', 'allowed-tools', 'metadata', 'compatibility']);

/**
 * AICO's own frontmatter keys. Read at the top level (existing skills use
 * them there) and under `metadata` as `aico-<key>`; export moves them there.
 */
export const AICO_KEYS: Record<string, string> = {
  trigger: 'aico-trigger',
  antiTrigger: 'aico-anti-trigger',
  aliases: 'aico-aliases',
  author: 'aico-author',
  version: 'aico-version',
};

export interface Validation {
  errors: string[];
  warnings: string[];
}

const XML_TAG = /<\/?[A-Za-z][\w:-]*(\s[^<>]*)?\/?>/;
const NAME_RULE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

/**
 * Check a skill's frontmatter (and optionally its body and folder name).
 *
 * `strict` is for skills crossing the boundary (import/export); without it,
 * the name rules and the folder match are warnings.
 */
export function validateFrontmatter(
  data: FmMap,
  opts: { dirName?: string; body?: string; strict?: boolean } = {},
): Validation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const nameProblem = (msg: string): void => { (opts.strict ? errors : warnings).push(msg); };

  const rawName = data.name;
  if (rawName === undefined || rawName === null || (typeof rawName === 'string' && !rawName.trim())) {
    errors.push('name is missing — add `name: my-skill` (lowercase letters, digits and hyphens).');
  } else if (typeof rawName !== 'string') {
    errors.push('name must be a single line of text, not a list or a map.');
  } else {
    const name = rawName.trim();
    if (name.length > NAME_MAX) nameProblem(`name is ${fmt(name.length)} characters; the limit is ${NAME_MAX} — shorten it.`);
    if (!NAME_RULE.test(name)) {
      const suggestion = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      nameProblem(`name "${name}" may use only lowercase letters, digits and single hyphens, and cannot start or end with a hyphen`
        + (suggestion && suggestion !== name ? ` — try "${suggestion}".` : '.'));
    }
    if (XML_TAG.test(name)) errors.push('name contains an XML tag — remove the angle brackets.');
    if (/anthropic|claude/i.test(name)) nameProblem(`name "${name}" contains a reserved word ("anthropic" or "claude") — rename it.`);
    if (opts.dirName && opts.dirName !== name) {
      warnings.push(`the folder is "${opts.dirName}" but the name is "${name}" — it is installed as "${name}/".`);
    }
  }

  const rawDescription = data.description;
  if (rawDescription === undefined || rawDescription === null || (typeof rawDescription === 'string' && !rawDescription.trim())) {
    errors.push('description is missing — say what the skill does and when to use it; it is the only part the agent sees before choosing.');
  } else if (typeof rawDescription !== 'string') {
    errors.push('description must be text, not a list or a map.');
  } else {
    const d = rawDescription.trim();
    if (d.length > DESCRIPTION_MAX) {
      errors.push(`description is ${fmt(d.length)} characters; the limit is ${fmt(DESCRIPTION_MAX)} — move detail into the body.`);
    } else if (d.length > DESCRIPTION_CLAUDE_AI) {
      warnings.push(`description is ${fmt(d.length)} characters; claude.ai's upload form accepts ${DESCRIPTION_CLAUDE_AI} (the spec allows ${fmt(DESCRIPTION_MAX)}).`);
    }
    if (XML_TAG.test(d)) errors.push('description contains an XML tag — remove the angle brackets or describe the tag in words.');
  }

  const compat = data.compatibility;
  if (compat !== undefined && compat !== null) {
    if (typeof compat !== 'string') errors.push('compatibility must be text.');
    else if (compat.length > COMPATIBILITY_MAX) errors.push(`compatibility is ${fmt(compat.length)} characters; the limit is ${COMPATIBILITY_MAX} — shorten it.`);
  }

  const license = data.license;
  if (license !== undefined && license !== null && typeof license !== 'string') errors.push('license must be text (a licence name or a file reference).');

  const meta = data.metadata;
  if (meta !== undefined && meta !== null) {
    if (typeof meta !== 'object' || Array.isArray(meta)) {
      errors.push('metadata must be a map of `key: value` lines.');
    } else {
      const nonString = Object.entries(meta).filter(([, v]) => typeof v !== 'string' && v !== null).map(([k]) => k);
      if (nonString.length) warnings.push(`metadata values should be text; ${nonString.join(', ')} ${nonString.length === 1 ? 'is' : 'are'} not.`);
    }
  }

  const tools = data['allowed-tools'] ?? data.allowedTools;
  if (tools !== undefined && tools !== null && typeof tools !== 'string' && !Array.isArray(tools)) {
    errors.push('allowed-tools must be a list or a space-separated line of tool names.');
  }

  if (opts.body !== undefined) {
    const lines = opts.body.split('\n').length;
    if (!opts.body.trim()) warnings.push('the body is empty — there is no procedure to follow.');
    if (lines > BODY_LINES_MAX) warnings.push(`the body is ${fmt(lines)} lines; keep SKILL.md under ${BODY_LINES_MAX} and move detail into references/.`);
  }

  return { errors, warnings };
}

/**
 * Warnings about a skill's reference files: ones nested deeper than the spec's
 * "one level" and long ones without a table of contents (the reader is told
 * to read them, so it should be able to find its way).
 */
export function referenceWarnings(body: string, files: Array<{ path: string; text?: string }>): string[] {
  const warnings: string[] = [];
  const mentioned = new Set<string>();
  for (const m of body.matchAll(/(?<![\w/.\\])((?:references|reference|docs)\/[\w./-]+\.[A-Za-z0-9]{1,6})/g)) mentioned.add(m[1]!);
  for (const p of mentioned) {
    if (p.split('/').length > 2) warnings.push(`${p} is nested more than one level below the skill — keep references one level deep.`);
  }
  for (const f of files) {
    if (!/^(references?|docs)\/[^/]+\.md$/i.test(f.path) || f.text === undefined) continue;
    const n = f.text.split('\n').length;
    if (n > 100 && !/^#{1,3}\s*(table of )?contents\b/im.test(f.text) && !/^\s*[-*]\s+\[[^\]]+\]\(#/m.test(f.text)) {
      warnings.push(`${f.path} is ${n} lines with no table of contents — add one so the agent can jump to the part it needs.`);
    }
  }
  return warnings;
}
