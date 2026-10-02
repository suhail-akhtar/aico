/**
 * Teach AICO, the pure part: describing a recorded element, finding it again,
 * turning a recording into steps, parameters, and the skill that holds them.
 * Plain data in, plain data out — every rule is unit-tested
 * (scripts/test-browser-teach.mjs); the page and Electron live in
 * browser-teach.ts and browser-teach-page.ts.
 *
 * WHAT SHAPED IT. Record-and-replay tools fail in three well-known ways, and
 * each has a rule here:
 *   - brittle selectors: a step stores a description (role + accessible name
 *     + label + nearby text + form, as Playwright's role/label locators do),
 *     and `relocate` scores today's elements against it. CSS/XPath are worth a
 *     few points, never a match on their own. When nothing fits clearly, the
 *     answer is "not sure" — replay then hands the step to the model with its
 *     intent instead of clicking a guess;
 *   - recorded secrets: codegen-style recorders write the password into the
 *     script. Here a sensitive field (browser-safety.ts decides, the same rule
 *     the agent's own typing obeys) becomes a `secret` action with no value,
 *     even if the page reported one;
 *   - demo data baked in: typed text becomes a named parameter by default
 *     ({{full_name}}), with what was typed as its default the person can clear.
 *
 * What it deliberately does not do: guess intent with a model. The intent of a
 * step is written from its description; the model's judgement is used only at
 * replay, and only when a step cannot be found.
 *
 * @module desktop/electron/browser-teach-core
 */

import { classifySensitiveField, type FieldDescriptor } from './browser-safety';
import type {
  DraftStep, Procedure, ProcedureAction, ProcedureParam, ProcedureStep, ProcedureSummary, RawTarget, SecretKind, TargetDesc, TeachSaveRequest,
} from '../shared/teach-types';

const clean = (s: unknown): string => String(s ?? '').replace(/\s+/g, ' ').trim();
const clip = (s: unknown, n = 120): string => { const t = clean(s); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const norm = (s: unknown): string => clean(s).toLowerCase().replace(/[“”"'’‘:*→←›»«‹…]+/g, '').replace(/\s+/g, ' ').trim();
const tokens = (s: unknown): string[] => norm(s).split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 1);

// ── Describing an element ──

const TEXTBOX_TYPES = new Set(['', 'text', 'email', 'tel', 'url', 'search', 'number', 'password', 'date', 'time', 'datetime-local', 'month', 'week']);

/** The ARIA role a person (or a screen reader) would give it. */
export function roleOf(raw: Pick<RawTarget, 'tag' | 'type' | 'roleAttr' | 'href'>): string {
  const explicit = clean(raw.roleAttr).split(' ')[0]?.toLowerCase();
  if (explicit) return explicit;
  const tag = clean(raw.tag).toLowerCase();
  const type = clean(raw.type).toLowerCase();
  if (tag === 'a') return raw.href ? 'link' : 'generic';
  if (tag === 'button' || tag === 'summary') return 'button';
  if (tag === 'select') return 'combobox';
  if (tag === 'textarea') return 'textbox';
  if (tag === 'input') {
    if (['submit', 'button', 'reset', 'image'].includes(type)) return 'button';
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'file') return 'file';
    if (type === 'range') return 'slider';
    if (TEXTBOX_TYPES.has(type)) return 'textbox';
  }
  return tag || 'generic';
}

const BUTTONISH = new Set(['button', 'link', 'tab', 'menuitem', 'option', 'switch', 'checkbox', 'radio']);

/** The accessible name, in the order browsers compute it (simplified). */
export function nameOf(raw: RawTarget): string {
  const role = roleOf(raw);
  const own = BUTTONISH.has(role) ? (raw.text || raw.buttonValue || raw.alt) : '';
  return clip(raw.ariaLabel || raw.labelledBy || (role === 'checkbox' || role === 'radio' ? raw.labelText || own : own || raw.labelText)
    || raw.placeholder || raw.title || raw.alt || raw.text || raw.buttonValue || '', 100);
}

export function describeTarget(raw: RawTarget): TargetDesc {
  const attrs: NonNullable<TargetDesc['attrs']> = {};
  if (raw.id) attrs.id = clip(raw.id, 80);
  if (raw.name) attrs.name = clip(raw.name, 80);
  if (raw.testId) attrs.testId = clip(raw.testId, 80);
  if (raw.href) attrs.href = clip(raw.href, 200);
  if (raw.autocomplete) attrs.autocomplete = clip(raw.autocomplete, 60);
  const d: TargetDesc = { role: roleOf(raw), name: nameOf(raw), tag: clean(raw.tag).toLowerCase() || 'element' };
  if (raw.type) d.type = clean(raw.type).toLowerCase();
  if (raw.labelText) d.label = clip(raw.labelText, 100);
  if (raw.text && raw.text !== d.name) d.text = clip(raw.text, 100);
  if (raw.placeholder) d.placeholder = clip(raw.placeholder, 80);
  if (raw.nearby) d.nearby = clip(raw.nearby, 100);
  if (raw.form) d.form = clip(raw.form, 100);
  if (Object.keys(attrs).length) d.attrs = attrs;
  if (raw.css) d.css = clip(raw.css, 300);
  if (raw.xpath) d.xpath = clip(raw.xpath, 300);
  return d;
}

/** Is this a field whose value is the person's alone (password, card, CVV, one-time code)? The browser's own rule. */
export function sensitiveKind(t: TargetDesc | RawTarget): SecretKind | null {
  const f: FieldDescriptor = 'role' in t
    ? { tag: t.tag, type: t.type, autocomplete: t.attrs?.autocomplete, name: t.attrs?.name, id: t.attrs?.id, label: t.label, placeholder: t.placeholder, ariaLabel: t.name }
    : {
      tag: t.tag, type: t.type, autocomplete: t.autocomplete, name: t.name, id: t.id, label: t.labelText, placeholder: t.placeholder, ariaLabel: t.ariaLabel,
      inputmode: t.inputmode, ...(typeof t.maxLength === 'number' ? { maxLength: t.maxLength } : {}),
    };
  // Only fields hold secrets: a button called "Forgot password?" is not one.
  if (!/^(input|textarea|select)$/i.test(f.tag ?? '')) return null;
  return classifySensitiveField(f)?.kind ?? null;
}

/** How a step names its element to a person: “Full name”, the “Continue” button. */
export function targetPhrase(d: TargetDesc | undefined): string {
  if (!d) return 'the page';
  const name = d.name || d.label || d.placeholder || d.text || d.attrs?.name || d.tag;
  return `“${clip(name, 60)}”`;
}

// ── Finding it again ──

/** An id that a build tool or framework generated (changes between deploys) is weak evidence. */
const generatedId = (id: string): boolean => /\d{3,}|[a-f0-9]{8,}|^(ember|react|radix|mui|headlessui|:r)/i.test(id);

function overlap(a: string, b: string): number {
  const A = new Set(tokens(a)); const B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const x of A) if (B.has(x)) n++;
  return n / Math.max(A.size, B.size);
}

const CLICKY = new Set(['button', 'link', 'menuitem', 'tab', 'option']);

/** How well does this element fit the recorded description? Points, with the reasons (for the report). */
export function scoreCandidate(want: TargetDesc, cand: RawTarget): { score: number; why: string[] } {
  const got = describeTarget(cand);
  let score = 0;
  const why: string[] = [];
  const add = (n: number, reason: string): void => { score += n; why.push(`${n > 0 ? '+' : ''}${n} ${reason}`); };
  if (got.role === want.role) add(20, 'role');
  else if (CLICKY.has(got.role) && CLICKY.has(want.role)) add(6, 'clickable');
  else add(-25, `role ${got.role}≠${want.role}`);
  const wa = want.attrs ?? {}; const ga = got.attrs ?? {};
  if (wa.testId && ga.testId === wa.testId) add(40, 'test id');
  if (wa.id && ga.id === wa.id) add(generatedId(wa.id) ? 6 : 25, 'id');
  if (wa.name && ga.name === wa.name) add(20, 'name attribute');
  if (want.name && got.name) {
    if (norm(want.name) === norm(got.name)) add(30, 'accessible name');
    else { const o = overlap(want.name, got.name); if (o >= 0.5) add(Math.round(18 * o), 'similar name'); }
  }
  if (want.label && got.label && norm(want.label) === norm(got.label) && norm(want.label) !== norm(want.name)) add(12, 'label');
  if (want.placeholder && got.placeholder && norm(want.placeholder) === norm(got.placeholder)) add(8, 'placeholder');
  if (wa.href && ga.href && wa.href === ga.href) add(15, 'link target');
  if (want.type && got.type === want.type) add(5, 'type');
  if (want.nearby && got.nearby && norm(want.nearby) === norm(got.nearby)) add(8, 'nearby text');
  if (want.form && got.form && want.form === got.form) add(8, 'same form');
  if (want.css && got.css === want.css) add(5, 'css');
  if (want.xpath && got.xpath === want.xpath) add(5, 'xpath');
  if (cand.disabled) add(-10, 'disabled');
  return { score, why };
}

export interface Relocated {
  ref?: string;
  score: number;
  /** high: act on it. low: not sure — hand the step to the model with its intent. */
  confidence: 'high' | 'low';
  reason: string;
  best?: { ref?: string; name: string; role: string; score: number };
  runnerUp?: { name: string; score: number };
}

/**
 * The element on the page now that best fits the description, or "not sure".
 *
 * Sure means: a clear score (≥ 40) with daylight (≥ 8) over the next one —
 * or, for a control that was renamed and moved (its name and position both
 * changed), the ONLY element of its role in the same form, with a modest score.
 */
export function relocate(want: TargetDesc, cands: RawTarget[]): Relocated {
  const live = cands.filter(c => c.visible !== false && c.ref);
  if (!live.length) return { score: 0, confidence: 'low', reason: 'no visible interactive elements on the page' };
  const scored = live.map(c => ({ c, ...scoreCandidate(want, c) })).sort((a, b) => b.score - a.score);
  const top = scored[0]!;
  const second = scored[1];
  const margin = top.score - (second?.score ?? 0);
  const topDesc = describeTarget(top.c);
  const best = { ref: top.c.ref, name: topDesc.name, role: topDesc.role, score: top.score };
  const runnerUp = second ? { name: describeTarget(second.c).name, score: second.score } : undefined;
  if (top.score >= 40 && margin >= 8) return { ref: top.c.ref, score: top.score, confidence: 'high', reason: top.why.join(', '), best, ...(runnerUp ? { runnerUp } : {}) };
  // Renamed and moved: still the one and only control of its kind in its form.
  if (want.form && top.score >= 28) {
    const sameKind = live.filter(c => roleOf(c) === want.role && c.form === want.form && (!want.type || clean(c.type).toLowerCase() === want.type));
    if (sameKind.length === 1 && sameKind[0] === top.c) {
      return { ref: top.c.ref, score: top.score, confidence: 'high', reason: `${top.why.join(', ')}; the only ${want.role} of its kind in its form`, best, ...(runnerUp ? { runnerUp } : {}) };
    }
  }
  return {
    score: top.score, confidence: 'low', best, ...(runnerUp ? { runnerUp } : {}),
    reason: top.score < 40 ? `best match scored only ${top.score} (${top.why.join(', ')})` : `two elements fit almost equally (${top.score} vs ${second?.score ?? 0})`,
  };
}

// ── From a recording to steps ──

/** One thing the recorder saw (the page's report, or main's own navigation event). */
export interface RecordedEvent {
  kind: 'click' | 'type' | 'select' | 'press' | 'upload' | 'navigate';
  at: number;
  url: string;
  target?: RawTarget;
  value?: string;
  optionText?: string;
  key?: string;
  files?: number;
  checked?: boolean;
  shot?: DraftStep['shots'][number];
}

export const originOfUrl = (u: string): string => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.origin : ''; } catch { return ''; } };
const pathOf = (u: string): string => { try { const x = new URL(u); return `${x.origin}${x.pathname}`; } catch { return u; } };

/** A parameter name from the field's own words: "Full name" → full_name. */
export function paramName(d: TargetDesc | undefined, taken: Set<string>): string {
  const base = (clean(d?.label || d?.name || d?.placeholder || d?.attrs?.name || 'value').toLowerCase()
    .normalize('NFKD').replace(/\p{M}+/gu, '').replace(/[^\w\s-]/g, '').replace(/[\s-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32)) || 'value';
  const start = /^\d/.test(base) ? `field_${base}` : base;
  let n = start; let i = 2;
  while (taken.has(n)) n = `${start}_${i++}`;
  taken.add(n);
  return n;
}

const sameTarget = (a?: RawTarget, b?: RawTarget): boolean => Boolean(a && b && ((a.css && a.css === b.css) || (a.xpath && a.xpath === b.xpath)));

function titleFor(a: ProcedureAction): string {
  const t = targetPhrase(a.target);
  switch (a.kind) {
    case 'navigate': { try { const u = new URL(a.url ?? ''); return `Open ${u.host}${u.pathname === '/' ? '' : ' (' + u.pathname.replace(/\//g, ' / ').trim() + ')'}`; } catch { return 'Open the page'; } }
    case 'click': return a.target?.role === 'checkbox' || a.target?.role === 'radio' ? `${a.expect?.checked === false ? 'Untick' : 'Tick'} ${t}` : `Click ${t}`;
    case 'type': return `Type ${a.param ? `{{${a.param}}}` : 'text'} into ${t}`;
    case 'select': return `Choose “${clip(a.optionText || a.value, 40)}” in ${t}`;
    case 'press': return `Press ${a.key ?? 'Enter'}`;
    case 'upload': return `Attach a file to ${t}`;
    case 'secret': return a.secret?.kind === 'password' ? `Password in ${t} — a stored credential or you (never recorded)` : `${a.secret?.kind === 'otp' ? 'One-time code' : 'Card details'} in ${t} — you enter it (never recorded)`;
    case 'wait': return a.wait?.text ? `Wait for “${clip(a.wait.text, 40)}”` : `Wait ${a.wait?.ms ?? 1000} ms`;
  }
}

function intentFor(a: ProcedureAction): string {
  const d = a.target;
  const where = d ? [d.form ? `in the form “${clip(d.form, 40)}”` : '', d.nearby ? `under “${clip(d.nearby, 50)}”` : ''].filter(Boolean).join(', ') : '';
  const what = d ? `the ${d.role} ${targetPhrase(d)}${where ? ` (${where})` : ''}` : '';
  switch (a.kind) {
    case 'navigate': return `Go to the starting page of this task on ${originOfUrl(a.url ?? '') || 'the site'}.`;
    case 'click': return `Activate ${what}${a.expect?.url ? ', which leads to the next page' : ''}.`;
    case 'type': return `Enter ${a.param ? `the ${a.param.replace(/_/g, ' ')}` : 'the recorded text'} in ${what}.`;
    case 'select': return `Pick the option “${clip(a.optionText || a.value, 40)}” in ${what}.`;
    case 'press': return `Press ${a.key ?? 'Enter'} to submit or confirm.`;
    case 'upload': return `Attach the file(s) to ${what}.`;
    case 'secret': return `The person's ${a.secret?.kind ?? 'secret'} goes in ${what} — sign in with a stored credential, or hand over to the person.`;
    case 'wait': return a.wait?.text ? `Wait until the page shows “${clip(a.wait.text, 40)}”.` : 'Give the page a moment.';
  }
}

export function newStep(id: string, a: ProcedureAction, shot?: DraftStep['shots'][number]): DraftStep {
  return { id, title: titleFor(a), intent: intentFor(a), actions: [a], shots: shot ? [shot] : [] };
}

/**
 * Turn what the recorder saw into reviewable steps: one action per step,
 * repeated typing in one field folded into its last value, secrets emptied,
 * typed text made a parameter, and each action's expected outcome (the page
 * it led to) taken from what happened next.
 */
export function buildDraftSteps(events: RecordedEvent[], start: { url: string; shot?: DraftStep['shots'][number] }, finalUrl?: string): { steps: DraftStep[]; notes: string[] } {
  const notes: string[] = [];
  // Fold: consecutive typing into the same field keeps only the last value.
  const folded: RecordedEvent[] = [];
  for (const e of events) {
    const prev = folded[folded.length - 1];
    if (e.kind === 'type' && prev?.kind === 'type' && sameTarget(prev.target, e.target)) { folded[folded.length - 1] = { ...e, shot: e.shot ?? prev.shot }; continue; }
    // A navigation the same URL as the page already on (a reload of state) adds nothing.
    if (e.kind === 'navigate' && prev && prev.url === e.url && prev.kind === 'navigate') continue;
    folded.push(e);
  }
  const taken = new Set<string>();
  const steps: DraftStep[] = [newStep('s1', { kind: 'navigate', url: start.url, origin: originOfUrl(start.url), expect: { url: pathOf(start.url) } }, start.shot)];
  folded.forEach((e, i) => {
    const nextUrl = folded[i + 1]?.url ?? finalUrl ?? e.url;
    const origin = originOfUrl(e.url);
    const target = e.target ? describeTarget(e.target) : undefined;
    const led = pathOf(nextUrl) !== pathOf(e.url) ? { url: pathOf(nextUrl) } : undefined;
    let a: ProcedureAction;
    if (e.kind === 'navigate') a = { kind: 'navigate', url: e.url, origin, expect: { url: pathOf(e.url) } };
    else if (e.kind === 'type') {
      const secret = e.target ? sensitiveKind(e.target) : null;
      if (secret) {
        // Whatever the page sent, nothing of a secret is kept.
        const p = secret === 'password' ? paramName({ role: 'textbox', name: 'credential', tag: 'input' }, taken) : undefined;
        a = { kind: 'secret', target, origin, secret: { kind: secret, ...(p ? { param: p } : {}) } };
        notes.push(secret === 'password'
          ? `${targetPhrase(target)} is a password field: nothing was recorded. On replay it is filled from a stored credential you name (parameter “${p}”), or AICO hands the page to you.`
          : `${targetPhrase(target)} is a ${secret === 'otp' ? 'one-time code' : 'payment card'} field: nothing was recorded, and on replay AICO always hands it to you.`);
      } else {
        a = { kind: 'type', target, origin, value: e.value ?? '', param: paramName(target, taken) };
      }
    } else if (e.kind === 'select') a = { kind: 'select', target, origin, value: e.value ?? '', ...(e.optionText ? { optionText: e.optionText } : {}) };
    else if (e.kind === 'press') a = { kind: 'press', key: e.key || 'Enter', origin, ...(led ? { expect: led } : {}) };
    else if (e.kind === 'upload') {
      const p = paramName({ ...(target ?? { role: 'file', name: 'file', tag: 'input' }), label: `${target?.label || target?.name || 'file'} file` }, taken);
      a = { kind: 'upload', target, origin, value: `{{${p}}}`, param: p };
      notes.push(`The file attached to ${targetPhrase(target)} was not recorded: on replay give its path as “${p}” (the person approves every upload).`);
    } else {
      const toggle = target?.role === 'checkbox' || target?.role === 'radio' || target?.role === 'switch';
      a = { kind: 'click', target, origin, ...(toggle && typeof e.checked === 'boolean' ? { expect: { checked: e.checked } } : led ? { expect: led } : {}) };
    }
    steps.push(newStep(`s${steps.length + 1}`, a, e.shot));
  });
  return { steps, notes };
}

// ── Parameters ──

const PARAM_RE = /\{\{\s*([a-z_][\w]*)\s*\}\}/gi;

export function paramsIn(text: string | undefined): string[] {
  return [...String(text ?? '').matchAll(PARAM_RE)].map(m => m[1]!.toLowerCase());
}

/** Put the run's values into a step's text. `{{secret:…}}` is never substituted. Unknown names are an error, not an empty string. */
export function substitute(text: string, values: Record<string, string>): string {
  return text.replace(PARAM_RE, (_m, name: string) => {
    const k = name.toLowerCase();
    if (!(k in values)) throw new Error(`No value for the parameter {{${k}}}.`);
    return values[k]!;
  });
}

/** The run's values: given ones first, then defaults; missing required ones and unknown names are reported. */
export function resolveParams(proc: Pick<Procedure, 'params'>, given: Record<string, unknown> | undefined): { values: Record<string, string>; missing: string[]; unknown: string[] } {
  const values: Record<string, string> = {};
  const missing: string[] = [];
  const known = new Set(proc.params.map(p => p.name));
  const g: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(given ?? {})) g[k.toLowerCase().replace(/^\{\{|\}\}$/g, '')] = v;
  for (const p of proc.params) {
    const v = g[p.name];
    if (v !== undefined && v !== null && String(v) !== '') values[p.name] = Array.isArray(v) ? v.map(String).join('\n') : String(v);
    else if (p.default !== undefined && p.kind !== 'secret') values[p.name] = p.default;
    else if (p.required) missing.push(p.name);
  }
  return { values, missing, unknown: Object.keys(g).filter(k => !known.has(k)) };
}

// ── Saving: review edits → procedure.json + SKILL.md ──

/** A skill name the validator accepts: lower-case words joined by hyphens. */
export function skillName(raw: string): string {
  return clean(raw).toLowerCase().normalize('NFKD').replace(/\p{M}+/gu, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/, '');
}

const nameOk = (n: string): boolean => /^[a-z_][\w]{0,40}$/.test(n);

/**
 * Check what the review page sends back and make the procedure. The page is
 * the person's, but the rules are re-applied here: a secret field never takes
 * a literal value, every {{param}} is declared, every action stays on the
 * recorded origin.
 */
export function prepareProcedure(req: TeachSaveRequest, draft: { origin: string; startUrl: string }, now = new Date()): { procedure?: Procedure; errors: string[] } {
  const errors: string[] = [];
  const name = skillName(req.name);
  if (!name) errors.push('Give the procedure a name (letters, digits and hyphens).');
  const goal = clip(req.goal, 300).replace(/[<>]/g, '');
  if (goal.length < 8) errors.push('Describe the goal in a few words — it is how chats know when to use this procedure.');
  if (!Array.isArray(req.steps) || !req.steps.length) errors.push('There are no steps left.');
  const params = new Map<string, ProcedureParam>();
  const steps: ProcedureStep[] = [];
  (req.steps ?? []).forEach((s, i) => {
    const actions: ProcedureAction[] = [];
    for (const a0 of s.actions ?? []) {
      const a: ProcedureAction = { ...a0 };
      if (a.origin && a.origin !== draft.origin && a.kind !== 'navigate') errors.push(`Step ${i + 1} acts on ${a.origin}; a procedure stays on ${draft.origin}.`);
      if (a.kind === 'navigate' && originOfUrl(a.url ?? '') !== draft.origin && !paramsIn(a.url).length) errors.push(`Step ${i + 1} opens ${a.url}, outside ${draft.origin}.`);
      if (a.target && a.kind !== 'secret') {
        const k = sensitiveKind(a.target);
        if (k && (a.kind === 'type' || a.kind === 'select')) { a.kind = 'secret'; a.secret = { kind: k }; delete a.value; delete a.param; }
      }
      if (a.kind === 'type' || a.kind === 'upload') {
        if (a.param !== undefined && a.param !== '') {
          const p = a.param.toLowerCase();
          if (!nameOk(p)) { errors.push(`Step ${i + 1}: “${a.param}” is not a usable parameter name (letters, digits, underscores).`); continue; }
          const literal = a.kind === 'type' && a.value !== undefined && !paramsIn(a.value).length ? a.value : undefined;
          if (!params.has(p)) {
            params.set(p, {
              name: p, label: clip(a.target?.label || a.target?.name || p.replace(/_/g, ' '), 60), kind: a.kind === 'upload' ? 'file' : 'text',
              ...(literal ? { default: literal } : {}), required: !literal,
            });
          }
          a.value = `{{${p}}}`;
        } else if (a.kind === 'upload') { errors.push(`Step ${i + 1}: a file upload needs a parameter for the file path.`); continue; }
        delete a.param;
      }
      if (a.kind === 'secret') {
        delete a.value;
        if (a.secret?.kind === 'password') {
          const p = (a.secret.param || 'credential').toLowerCase();
          if (!params.has(p)) params.set(p, { name: p, label: 'Stored credential name (optional — otherwise you sign in yourself)', kind: 'secret', required: false });
          a.secret = { kind: 'password', param: p };
        } else if (a.secret) a.secret = { kind: a.secret.kind };
      }
      for (const ref of [...paramsIn(a.url), ...paramsIn(a.kind === 'type' || a.kind === 'upload' ? undefined : a.value)]) {
        if (!params.has(ref)) params.set(ref, { name: ref, label: ref.replace(/_/g, ' '), kind: 'text', required: true });
      }
      actions.push(a);
    }
    if (!actions.length) return;
    steps.push({ id: `s${steps.length + 1}`, title: clip(s.title, 160) || titleFor(actions[0]!), intent: clip(s.intent, 400) || intentFor(actions[0]!), actions });
  });
  if (errors.length || !name) return { errors };
  return {
    errors,
    procedure: { kind: 'aico.browser-procedure', version: 1, name, goal, origin: draft.origin, startUrl: draft.startUrl, params: [...params.values()], steps, createdAt: now.toISOString() },
  };
}

/** Text for SKILL.md: no URL paths with file extensions (the skill checker reads those as files the skill must ship). */
const safeLine = (s: string): string => clean(s).replace(/\//g, ' / ').replace(/[<>]/g, '');

/** The skill that carries a procedure: its catalogue line, its body (how to run it), and procedure.json. */
export function procedureSkill(p: Procedure): { name: string; description: string; body: string; json: string } {
  const host = (() => { try { return new URL(p.origin).host; } catch { return p.origin; } })();
  const params = p.params.map(x => `- \`${x.name}\` — ${safeLine(x.label)}${x.kind === 'secret' ? ' (the NAME of a stored credential, never a password)' : x.kind === 'file' ? ' (file path; the person approves the upload)' : x.default !== undefined ? ' (has a default)' : ' (required)'}`);
  const description = `Browser procedure taught on ${host}: ${safeLine(p.goal)}. Replays ${p.steps.length} recorded steps in AICO Desktop's built-in browser with the browser_run_procedure tool.`.slice(0, 1000);
  const body = [
    `# ${safeLine(p.goal)}`,
    '',
    `A procedure the user taught AICO by doing it once in the built-in browser on ${host}.`,
    `Run it with the \`browser_run_procedure\` tool: name \`${p.name}\`${p.params.length ? ', params { ' + p.params.map(x => `${x.name}: …`).join(', ') + ' }' : ''}.`,
    'It finds each element by its description, waits for the page, checks each step, stops for the user on purchases, sends, deletes, human checks and secrets, and reports every step.',
    'If it stops at a step it cannot find with confidence, do that step yourself (browser_snapshot, then act), then run it again with `startAt` set to the next step.',
    '',
    ...(params.length ? ['## Parameters', '', ...params, ''] : []),
    '## Steps',
    '',
    ...p.steps.map((s, i) => `${i + 1}. ${safeLine(s.title)}`),
    '',
  ].join('\n');
  return { name: p.name, description, body, json: `${JSON.stringify(p, null, 2)}\n` };
}

/** Read procedure.json defensively: a file in the user's store is data. */
export function parseProcedure(text: string): Procedure | null {
  try {
    const p = JSON.parse(text) as Procedure;
    if (p?.kind !== 'aico.browser-procedure' || p.version !== 1 || !Array.isArray(p.steps) || !Array.isArray(p.params) || !originOfUrl(p.startUrl) || originOfUrl(p.startUrl) !== p.origin) return null;
    return p;
  } catch { return null; }
}

export const summarise = (p: Procedure): ProcedureSummary => ({ name: p.name, goal: p.goal, origin: p.origin, params: p.params, steps: p.steps.length });

// ── Replay report ──

export type StepStatus = 'ok' | 'failed' | 'needs_judgement' | 'needs_user' | 'refused' | 'stopped' | 'skipped';

export interface StepResult { index: number; title: string; status: StepStatus; detail: string; verified?: boolean }

export function formatReport(r: { name: string; origin: string; status: string; steps: StepResult[]; total: number; next?: number; note?: string }): string {
  const lines = [`Procedure "${r.name}" on ${r.origin} — ${r.status} (${r.steps.filter(s => s.status === 'ok').length} of ${r.total} steps done).`];
  for (const s of r.steps) lines.push(`${s.index}. [${s.status}${s.status === 'ok' ? (s.verified ? ', verified' : ', not verified') : ''}] ${s.title} — ${s.detail}`);
  if (r.note) lines.push('', r.note);
  return lines.join('\n');
}
