/**
 * Rules about how the user works — proposed by the distiller, put in force
 * by the user, injected into the request tail when they apply.
 *
 * A rule is one imperative line ("Use pnpm, not npm.") with a *scope* —
 * everywhere, one project, or one language — a *topic* that names what it
 * decides ("package-manager"), and the evidence that led to it. It starts
 * `proposed` and does nothing until a person accepts it; the one exception is
 * the opt-in "auto-accept low-risk style rules" setting, and "low-risk style"
 * is decided here in code (formatting vocabulary, no commands, no tools, no
 * permissions), not by the model that proposed it.
 *
 * Merging is deterministic: a rule that says what another in the same scope
 * already says adds its evidence there; a rule on the same topic that says
 * something different *contradicts* it — a proposed rule is replaced at once,
 * an active one only when the person accepts the replacement, so an accepted
 * rule never disappears without their click. Forgetting deletes the rule and
 * keeps only a fingerprint, so the identical rule is not proposed again.
 *
 * Why the tail and not the cached prefix (AICO.md, "volatile in the tail"):
 * which rules apply depends on the project and the task, and they change when
 * the person accepts one. In the system prompt that churn would re-bill every
 * cached transcript; in the tail it costs at most {@link RULES_TOKEN_BUDGET}
 * tokens a step, most relevant first. `USER.md` stays what it was — a dozen
 * stable lines in the prefix — and is not written by this module.
 *
 * Guarding against drift and sycophancy: rules are about the work (tools,
 * style, process), never about agreeing with the person or praising them; a
 * rule text that reads like a person's data or a secret is refused outright;
 * and nothing is ever in force that a person has not seen.
 *
 * @module learning/preferences
 */

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { aicoHome } from '../home.js';
import { estimateTokens } from '../tokens.js';
import { meaningfulWords } from '../knowledge/match.js';
import { overlap } from './extract.js';
import { scrub, type SignalKind } from './signals.js';

export type RuleStatus = 'proposed' | 'active' | 'disabled' | 'superseded';
export type RuleCategory = 'style' | 'tooling' | 'workflow' | 'communication';
/** `global`, `project:<absolute root>` or `language:<name>`. */
export type RuleScope = string;

export interface RuleEvidence { sessionId: string; seq?: number; kind: SignalKind; excerpt: string; at: number }

export interface PreferenceRule {
  id: string;
  text: string;
  topic: string;
  scope: RuleScope;
  category: RuleCategory;
  status: RuleStatus;
  evidence: RuleEvidence[];
  createdAt: number;
  updatedAt: number;
  acceptedAt?: number;
  /** Put in force by the auto-accept setting rather than a click. */
  autoAccepted?: boolean;
  /** Active rules this one replaces when accepted (a contradiction). */
  replaces?: string[];
  supersededBy?: string;
  /** Written or edited by the person rather than distilled. */
  byUser?: boolean;
}

/** A rule as the distiller (or a fallback) proposes it, before merging. */
export interface RuleCandidate {
  text: string;
  topic?: string;
  scope: RuleScope;
  category?: RuleCategory;
  evidence: RuleEvidence[];
  replaces?: string[];
}

interface Store { version: 1; rules: PreferenceRule[]; forgotten: string[] }

export const RULES_TOKEN_BUDGET = 400;
export const MAX_RULE_CHARS = 200;
const MAX_EVIDENCE = 5;
const MAX_RULES = 200;
const SAME_RULE = 0.8;

export function rulesFile(): string {
  return path.join(aicoHome(), 'learning', 'preferences', 'rules.json');
}

export function loadStore(): Store {
  try {
    const raw = JSON.parse(fs.readFileSync(rulesFile(), 'utf8')) as Partial<Store>;
    return { version: 1, rules: Array.isArray(raw.rules) ? raw.rules : [], forgotten: Array.isArray(raw.forgotten) ? raw.forgotten : [] };
  } catch {
    return { version: 1, rules: [], forgotten: [] };
  }
}

export function saveStore(store: Store): void {
  const file = rulesFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Superseded rules are history, not state: keep the newest few for the page.
  const live = store.rules.filter(r => r.status !== 'superseded');
  const old = store.rules.filter(r => r.status === 'superseded').sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 20);
  const rules = [...live, ...old].slice(0, MAX_RULES);
  fs.writeFileSync(file, JSON.stringify({ version: 1, rules, forgotten: store.forgotten.slice(-500) }, null, 2), 'utf8');
}

export function listRules(): PreferenceRule[] {
  return loadStore().rules;
}

// ── Normalising and refusing ────────────────────────────────────────────────

const LANGUAGE_ALIASES: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', typescript: 'typescript', js: 'javascript', javascript: 'javascript', node: 'javascript',
  py: 'python', python: 'python', go: 'go', golang: 'go', rust: 'rust', rs: 'rust', java: 'java', kotlin: 'kotlin',
  'c#': 'csharp', csharp: 'csharp', ruby: 'ruby', php: 'php', swift: 'swift', css: 'css', html: 'html', sql: 'sql',
  markdown: 'markdown', shell: 'shell', bash: 'shell', powershell: 'powershell',
};

export function normaliseLanguage(name: string): string | undefined {
  return LANGUAGE_ALIASES[name.trim().toLowerCase()];
}

/** `global`, `project:<root>` (resolved) or `language:<known name>`; anything else is global. */
export function normaliseScope(scope: string | undefined, projectRoot?: string): RuleScope {
  const s = (scope ?? '').trim();
  if (s === 'project' && projectRoot) return `project:${path.resolve(projectRoot)}`;
  if (s.startsWith('project:')) return `project:${path.resolve(s.slice(8))}`;
  if (s.startsWith('language:')) {
    const lang = normaliseLanguage(s.slice(9));
    if (lang) return `language:${lang}`;
  }
  return 'global';
}

/** Topics the code knows, so two phrasings of one decision collide no matter what the model called them. */
const KNOWN_TOPICS: Array<[RegExp, string]> = [
  [/\b(npm|pnpm|yarn|bun)\b/i, 'package-manager'],
  [/\b(tabs?|spaces?)\b.*\bindent|\bindent\w*\b.*\b(tabs?|spaces?)\b/i, 'indentation'],
  [/\b(single|double)[- ]quotes?\b/i, 'quotes'],
  [/\bsemicolons?\b/i, 'semicolons'],
  [/\b(tests? first|tdd|test[- ]driven|tests? before)\b/i, 'test-order'],
];

export function topicOf(text: string, proposed?: string): string {
  for (const [re, topic] of KNOWN_TOPICS) if (re.test(text)) return topic;
  const clean = (proposed ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  if (clean) return clean;
  return [...meaningfulWords(text)].slice(0, 3).join('-') || 'general';
}

const PERSONAL = /\b(health|medical|diagnos\w*|religio\w*|politic\w*|sexual\w*|pregnan\w*|salary|income|home address|birthday|my (?:wife|husband|partner|child|kids?|son|daughter|mother|father)|phone number|passport|social security)\b/i;
const SECRETISH = /\[(?:secret|email)\]|\{\{\s*secret:|\b(?:password|passwd|api[_ -]?key|token|bearer)\b\s*[:=]|\b[A-Za-z0-9+/_-]{32,}\b|\+?\d[\d\s().-]{8,}\d/i;
/** Rules about the person's approval or the agent's agreement are the drift this feature must not learn. */
const SYCOPHANTIC = /\b(agree with (?:me|the user)|(?:praise|flatter|compliment)\w*|tell me i'?m right|never (?:disagree|push back|question)|don'?t (?:disagree|push back|argue))\b/i;

/**
 * The rule as it may be stored, or the reason it may not. Runs every text —
 * distilled, edited or typed — through the redactor first, then refuses what
 * still looks like a secret, personal data, or an instruction to agree.
 */
export function sanitiseRuleText(raw: string): { ok: true; text: string } | { ok: false; reason: string } {
  let text = scrub(raw).replace(/\s+/g, ' ').trim().replace(/^[-*•]\s*/, '');
  if (text.length < 6) return { ok: false, reason: 'too short to be a rule' };
  if (text.length > MAX_RULE_CHARS) text = `${text.slice(0, MAX_RULE_CHARS - 1).replace(/\s+\S*$/, '')}…`;
  if (SECRETISH.test(text)) return { ok: false, reason: 'looks like it carries a secret or personal identifier' };
  if (PERSONAL.test(text)) return { ok: false, reason: 'is about the person, not the work' };
  if (SYCOPHANTIC.test(text)) return { ok: false, reason: 'asks the agent to agree rather than to work a certain way' };
  if (!/[.!)]$/.test(text)) text += '.';
  return { ok: true, text: text[0]!.toUpperCase() + text.slice(1) };
}

const STYLE_WORDS = /\b(indent\w*|tabs?|spaces?|quotes?|semicolons?|trailing commas?|line length|naming|camelcase|snake_case|kebab-case|pascalcase|format\w*|comments?|docstrings?|jsdoc|brace\w*|import order|blank lines?|whitespace|wrap\w*|arrow functions?|const\b|let\b|var\b|type annotations?|explicit types?|early returns?)\b/i;
const RISKY_WORDS = /\b(run|execute|delete|remove|rm|push|commit|deploy|publish|install|curl|wget|sudo|secret|password|token|credential|permission|approve|skip|disable|bypass|force|no-verify|network|http|download|upload|email|send)\b|`|https?:/i;

/** Low-risk style, decided in code: formatting vocabulary and none of the words that change what the agent does. */
export function isLowRiskStyle(rule: Pick<PreferenceRule, 'text' | 'category'>): boolean {
  return rule.category === 'style' && STYLE_WORDS.test(rule.text) && !RISKY_WORDS.test(rule.text);
}

function fingerprint(text: string, scope: string): string {
  return createHash('sha1').update(`${scope}|${[...meaningfulWords(text)].sort().join(' ')}`).digest('hex').slice(0, 16);
}

function ruleId(text: string, scope: string, now: number): string {
  return `pref-${createHash('sha1').update(`${scope}|${text}|${now}`).digest('hex').slice(0, 10)}`;
}

// ── Merging ─────────────────────────────────────────────────────────────────

function orderedWords(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9_.#+-]+/).filter(w => meaningfulWords(w).size > 0);
}

/**
 * Two texts are one rule when they share their words *in the same order*.
 * Word overlap alone calls "Use pnpm, not npm" and "Use npm, not pnpm" the
 * same rule — the exact contradiction this module exists to catch.
 */
export function sameRule(a: string, b: string): boolean {
  if (a.trim().toLowerCase() === b.trim().toLowerCase()) return true;
  if (overlap(a, b) < SAME_RULE) return false;
  const x = orderedWords(a);
  const y = orderedWords(b);
  const dp: number[] = new Array(y.length + 1).fill(0);
  for (let i = 1; i <= x.length; i++) {
    let prev = 0;
    for (let j = 1; j <= y.length; j++) {
      const tmp = dp[j]!;
      dp[j] = x[i - 1] === y[j - 1] ? prev + 1 : Math.max(dp[j]!, dp[j - 1]!);
      prev = tmp;
    }
  }
  return dp[y.length]! / Math.max(1, Math.min(x.length, y.length)) >= SAME_RULE;
}

export interface MergeResult { added: PreferenceRule[]; merged: PreferenceRule[]; replaced: PreferenceRule[]; refused: Array<{ text: string; reason: string }> }

/**
 * Fold candidates into the store. Pure over the store it is given (the
 * caller saves), so the harness can check duplicates, contradictions and
 * refusals without a disk.
 */
export function mergeCandidates(store: Store, candidates: readonly RuleCandidate[], opts: { autoAcceptStyle?: boolean; now?: number } = {}): MergeResult {
  const now = opts.now ?? Date.now();
  const result: MergeResult = { added: [], merged: [], replaced: [], refused: [] };
  for (const c of candidates) {
    const clean = sanitiseRuleText(c.text);
    if (!clean.ok) { result.refused.push({ text: c.text.slice(0, 80), reason: clean.reason }); continue; }
    const text = clean.text;
    const scope = c.scope || 'global';
    if (store.forgotten.includes(fingerprint(text, scope))) { result.refused.push({ text, reason: 'you asked AICO to forget this' }); continue; }
    const topic = topicOf(text, c.topic);
    const category: RuleCategory = c.category ?? 'workflow';
    const live = store.rules.filter(r => r.status !== 'superseded' && r.scope === scope);

    // The same rule again: more evidence, same decision. A disabled rule
    // stays disabled — the person turned it off, a repeat does not overrule them.
    const same = live.find(r => sameRule(r.text, text));
    if (same) {
      same.evidence = [...same.evidence, ...c.evidence].filter((e, i, all) => all.findIndex(x => x.sessionId === e.sessionId && x.seq === e.seq && x.kind === e.kind) === i).slice(-MAX_EVIDENCE);
      same.updatedAt = now;
      result.merged.push(same);
      continue;
    }

    // A different rule on the same topic in the same scope contradicts it.
    const clash = live.filter(r => r.status !== 'disabled' && (r.topic === topic || (c.replaces ?? []).includes(r.id)));
    const rule: PreferenceRule = {
      id: ruleId(text, scope, now), text, topic, scope, category, status: 'proposed',
      evidence: c.evidence.slice(-MAX_EVIDENCE), createdAt: now, updatedAt: now,
    };
    const replacesActive: string[] = [];
    for (const old of clash) {
      if (old.status === 'proposed') { old.status = 'superseded'; old.supersededBy = rule.id; old.updatedAt = now; result.replaced.push(old); }
      else if (old.status === 'active') replacesActive.push(old.id);
    }
    if (replacesActive.length) rule.replaces = replacesActive;
    if (opts.autoAcceptStyle && isLowRiskStyle(rule)) activate(store, rule, now, true);
    store.rules.push(rule);
    result.added.push(rule);
  }
  return result;
}

function activate(store: Store, rule: PreferenceRule, now: number, auto = false): void {
  rule.status = 'active';
  rule.acceptedAt = now;
  rule.updatedAt = now;
  if (auto) rule.autoAccepted = true;
  for (const id of rule.replaces ?? []) {
    const old = store.rules.find(r => r.id === id);
    if (old && old.id !== rule.id && old.status !== 'superseded') { old.status = 'superseded'; old.supersededBy = rule.id; old.updatedAt = now; }
  }
}

/** Active rules a new one contradicts on a topic the code itself recognises (for rules a person types). */
function knownClashes(store: Store, text: string, scope: string): string[] {
  const known = KNOWN_TOPICS.find(([re]) => re.test(text))?.[1];
  if (!known) return [];
  return store.rules.filter(r => r.status === 'active' && r.scope === scope && r.topic === known).map(r => r.id);
}

export type RuleAction =
  | { action: 'accept'; id: string }
  | { action: 'disable'; id: string }
  | { action: 'enable'; id: string }
  | { action: 'forget'; id: string }
  | { action: 'edit'; id: string; text?: string; scope?: string }
  | { action: 'add'; text: string; scope?: string; category?: RuleCategory };

/** Apply what a person did on the page. Pure over the store; the caller saves. */
export function applyRuleAction(store: Store, act: RuleAction, now = Date.now()): { ok: true; rule?: PreferenceRule } | { ok: false; error: string } {
  if (act.action === 'add') {
    const clean = sanitiseRuleText(act.text);
    if (!clean.ok) return { ok: false, error: `Not kept: it ${clean.reason}.` };
    const scope = normaliseScope(act.scope);
    const rule: PreferenceRule = {
      id: ruleId(clean.text, scope, now), text: clean.text, topic: topicOf(clean.text), scope,
      category: act.category ?? 'workflow', status: 'proposed', evidence: [], createdAt: now, updatedAt: now, byUser: true,
    };
    const clashes = knownClashes(store, clean.text, scope);
    if (clashes.length) rule.replaces = clashes;
    store.rules.push(rule);
    activate(store, rule, now);
    return { ok: true, rule };
  }
  const rule = store.rules.find(r => r.id === act.id);
  if (!rule) return { ok: false, error: `no rule "${act.id}"` };
  switch (act.action) {
    case 'accept':
    case 'enable':
      if (rule.status === 'superseded') return { ok: false, error: 'this rule was replaced by a newer one' };
      activate(store, rule, now);
      return { ok: true, rule };
    case 'disable':
      rule.status = 'disabled'; rule.updatedAt = now;
      return { ok: true, rule };
    case 'forget':
      store.forgotten.push(fingerprint(rule.text, rule.scope));
      store.rules = store.rules.filter(r => r.id !== rule.id);
      return { ok: true };
    case 'edit': {
      if (act.text !== undefined) {
        const clean = sanitiseRuleText(act.text);
        if (!clean.ok) return { ok: false, error: `Not saved: it ${clean.reason}.` };
        rule.text = clean.text;
        rule.topic = topicOf(clean.text, rule.topic);
      }
      if (act.scope !== undefined) rule.scope = normaliseScope(act.scope);
      rule.byUser = true;
      rule.updatedAt = now;
      return { ok: true, rule };
    }
  }
}

// ── Choosing what to inject ─────────────────────────────────────────────────

const LANGUAGE_MARKERS: Array<[string, string[]]> = [
  ['tsconfig.json', ['typescript', 'javascript']],
  ['package.json', ['javascript']],
  ['pyproject.toml', ['python']], ['setup.py', ['python']], ['requirements.txt', ['python']],
  ['go.mod', ['go']], ['Cargo.toml', ['rust']], ['pom.xml', ['java']], ['build.gradle', ['java']],
  ['Gemfile', ['ruby']], ['composer.json', ['php']],
];

/** The languages a project is in (from its marker files) plus any the task names. */
export function contextLanguages(projectRoot: string | undefined, task = ''): string[] {
  const langs = new Set<string>();
  if (projectRoot) {
    for (const [marker, names] of LANGUAGE_MARKERS) {
      try { if (fs.existsSync(path.join(projectRoot, marker))) names.forEach(n => langs.add(n)); } catch { /* unreadable: no signal */ }
    }
  }
  for (const word of task.toLowerCase().match(/\b(?:typescript|javascript|python|golang|rust|java|kotlin|ruby|php|swift|csharp|css|html|sql|bash|powershell)\b|(?<!\w)\.(?:tsx?|py|go|rs)\b/g) ?? []) {
    const lang = normaliseLanguage(word.replace(/^\./, ''));
    if (lang) langs.add(lang);
  }
  return [...langs].sort();
}

function inScope(rule: PreferenceRule, projectRoot: string | undefined, languages: readonly string[]): number {
  if (rule.scope === 'global') return 1;
  if (rule.scope.startsWith('project:')) {
    if (!projectRoot) return 0;
    const a = path.resolve(rule.scope.slice(8));
    const b = path.resolve(projectRoot);
    return (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b) ? 3 : 0;
  }
  if (rule.scope.startsWith('language:')) return languages.includes(rule.scope.slice(9)) ? 2 : 0;
  return 0;
}

/**
 * Active rules that apply here, most relevant first, within the budget.
 *
 * Relevance: a rule for this project outranks one for this language, which
 * outranks a global one; within that, overlap with the task's words, then how
 * much evidence it has, then the newest. Deterministic for a given store and
 * task, because the tail is re-sent every step and should not reshuffle.
 */
export function selectRules(rules: readonly PreferenceRule[], ctx: { projectRoot?: string; task?: string; languages?: string[] }, budgetTokens = RULES_TOKEN_BUDGET): PreferenceRule[] {
  const languages = ctx.languages ?? contextLanguages(ctx.projectRoot, ctx.task);
  const taskWords = meaningfulWords(ctx.task ?? '');
  const scored = rules
    .filter(r => r.status === 'active')
    .map(r => {
      const scope = inScope(r, ctx.projectRoot, languages);
      const words = meaningfulWords(r.text);
      let hits = 0;
      for (const w of words) if (taskWords.has(w)) hits++;
      return { r, scope, score: scope * 10 + (words.size ? (hits / words.size) * 5 : 0) + Math.min(r.evidence.length, 5) * 0.2 };
    })
    .filter(x => x.scope > 0)
    .sort((a, b) => b.score - a.score || b.r.updatedAt - a.r.updatedAt || a.r.id.localeCompare(b.r.id));
  const out: PreferenceRule[] = [];
  let used = estimateTokens(RULES_HEADER);
  for (const { r } of scored) {
    const cost = estimateTokens(`- ${r.text}\n`);
    if (used + cost > budgetTokens) break;
    used += cost;
    out.push(r);
  }
  return out;
}

const RULES_HEADER = 'How this user prefers to work (rules they accepted; follow them unless this task explicitly says otherwise):';

export function renderRules(rules: readonly PreferenceRule[]): string {
  return rules.length ? [RULES_HEADER, ...rules.map(r => `- ${r.text}`)].join('\n') : '';
}

/** The tail section for this task, or '' — one call for the agent loop. */
export function preferencesForTask(projectRoot: string | undefined, task: string): string {
  return renderRules(selectRules(listRules(), { ...(projectRoot ? { projectRoot } : {}), task }));
}
