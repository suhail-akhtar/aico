/**
 * Teach AICO — unit tests for electron/browser-teach-core.ts (and the page
 * script's shape): how a recorded element is described, how it is found again
 * after the page changed (and when replay must say "not sure" instead), that
 * secrets never survive a recording or a save, and how parameters are made
 * and filled in.
 *
 *   node scripts/test-browser-teach.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-desk-teach-'));

async function load(entry, name) {
  const file = path.join(out, `${name}.mjs`);
  await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile: file, logLevel: 'error', external: ['electron'] });
  return import(pathToFileURL(file).href);
}

let pass = 0; let fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); }
}

const c = await load(path.join(desktop, 'electron/browser-teach-core.ts'), 'teach-core');
const pg = await load(path.join(desktop, 'electron/browser-teach-page.ts'), 'teach-page');

// ── Describing an element ──
{
  const field = c.describeTarget({ tag: 'input', type: 'text', labelText: 'Full name', name: 'fullname', css: 'input[name="fullname"]', form: 'request', nearby: 'Your details' });
  ok(field.role === 'textbox' && field.name === 'Full name' && field.label === 'Full name' && field.attrs.name === 'fullname', 'describe: a labelled text field is a textbox named by its label', field);
  const btn = c.describeTarget({ tag: 'button', text: 'Continue', form: 'request' });
  ok(btn.role === 'button' && btn.name === 'Continue', 'describe: a button is named by its text', btn);
  const sub = c.describeTarget({ tag: 'input', type: 'submit', buttonValue: 'Send request' });
  ok(sub.role === 'button' && sub.name === 'Send request', 'describe: <input type=submit> is a button named by its value', sub);
  const aria = c.describeTarget({ tag: 'div', roleAttr: 'button', ariaLabel: 'Close dialog', text: '×' });
  ok(aria.role === 'button' && aria.name === 'Close dialog', 'describe: an explicit role and aria-label win', aria);
  const link = c.describeTarget({ tag: 'a', href: '/pricing', text: 'Pricing' });
  ok(link.role === 'link' && link.attrs.href === '/pricing', 'describe: a link keeps its target', link);
  const box = c.describeTarget({ tag: 'input', type: 'checkbox', labelText: 'I agree to the terms', checked: true });
  ok(box.role === 'checkbox' && box.name === 'I agree to the terms', 'describe: a checkbox is named by its label', box);
  ok(c.targetPhrase(field) === '“Full name”', 'describe: the phrase a person reads', c.targetPhrase(field));
}

// ── Secrets ──
{
  ok(c.sensitiveKind({ tag: 'input', type: 'password', labelText: 'Password' }) === 'password', 'secret: type=password');
  ok(c.sensitiveKind({ tag: 'input', type: 'text', autocomplete: 'cc-number' }) === 'card', 'secret: autocomplete cc-number is a card field');
  ok(c.sensitiveKind({ tag: 'input', type: 'text', name: 'otp', labelText: 'Code' }) === 'otp', 'secret: a one-time code field');
  ok(c.sensitiveKind({ tag: 'input', type: 'text', labelText: 'Card number' }) === 'card', 'secret: labelled "Card number"');
  ok(c.sensitiveKind({ tag: 'input', type: 'tel', labelText: 'CVV' }) === 'cvv', 'secret: CVV');
  ok(c.sensitiveKind({ tag: 'a', text: 'Forgot password?' }) === null, 'secret: a "Forgot password?" link is not a field');
  ok(c.sensitiveKind({ tag: 'input', type: 'text', labelText: 'Passenger name', name: 'passenger' }) === null, 'secret: "passenger" is not a password');
  ok(c.sensitiveKind(c.describeTarget({ tag: 'input', type: 'password', labelText: 'PIN' })) === 'password', 'secret: works on a stored description too');
}

// ── Finding it again ──
const cand = (o) => ({ visible: true, ...o });
{
  const want = c.describeTarget({ tag: 'input', type: 'text', labelText: 'Full name', name: 'fullname', form: 'request', css: 'form > input:nth-of-type(1)' });
  const page = [
    cand({ ref: 'e1', tag: 'input', type: 'text', labelText: 'Email', name: 'email', form: 'request' }),
    cand({ ref: 'e2', tag: 'input', type: 'text', labelText: 'Full name', name: 'fullname', form: 'request', css: 'div > input' }),
    cand({ ref: 'e3', tag: 'button', text: 'Continue', form: 'request' }),
  ];
  const r = c.relocate(want, page);
  ok(r.ref === 'e2' && r.confidence === 'high', 'relocate: the field is found by label and name though its position changed', r);

  const relabelled = c.relocate(want, [
    cand({ ref: 'e1', tag: 'input', type: 'text', labelText: 'Email', name: 'email', form: 'request' }),
    cand({ ref: 'e9', tag: 'input', type: 'text', labelText: 'Your full name', name: 'fullname', form: 'request' }),
  ]);
  ok(relabelled.ref === 'e9' && relabelled.confidence === 'high', 'relocate: a relabelled field is still found (name attribute + similar label)', relabelled);

  const btn = c.describeTarget({ tag: 'button', type: 'submit', text: 'Continue', form: 'request', css: 'form#request > div:nth-of-type(3) > button', xpath: '/html/body/form/div[3]/button' });
  const moved = c.relocate(btn, [
    cand({ ref: 'e1', tag: 'input', type: 'text', labelText: 'Full name', form: 'request' }),
    cand({ ref: 'e4', tag: 'a', href: '/help', text: 'Help' }),
    cand({ ref: 'e7', tag: 'button', type: 'submit', text: 'Next step', form: 'request', css: 'form#request > footer > button', xpath: '/html/body/form/footer/button' }),
  ]);
  ok(moved.ref === 'e7' && moved.confidence === 'high', 'relocate: a button that was renamed AND moved is found as the only submit button of its form', moved);

  const ambiguous = c.relocate(btn, [
    cand({ ref: 'e5', tag: 'button', type: 'submit', text: 'Save draft', form: 'request' }),
    cand({ ref: 'e6', tag: 'button', type: 'submit', text: 'Next step', form: 'request' }),
  ]);
  ok(ambiguous.confidence === 'low' && !ambiguous.ref, 'relocate: two equally plausible buttons → not sure (the model decides), never a guess', ambiguous);

  const sameName = c.relocate(c.describeTarget({ tag: 'button', text: 'Delete' }), [cand({ ref: 'a', tag: 'button', text: 'Delete' }), cand({ ref: 'b', tag: 'button', text: 'Delete' })]);
  ok(sameName.confidence === 'low', 'relocate: two identical "Delete" buttons are ambiguous', sameName);

  const tid = c.relocate(c.describeTarget({ tag: 'button', text: 'Go', testId: 'submit-order' }), [cand({ ref: 'x', tag: 'button', text: 'Go' }), cand({ ref: 'y', tag: 'button', text: 'Place it', testId: 'submit-order' })]);
  ok(tid.ref === 'y', 'relocate: a stable test id beats a matching text', tid);

  const genId = c.scoreCandidate(c.describeTarget({ tag: 'button', id: 'btn-8f3a2c9d1e', text: 'Go' }), { tag: 'span', id: 'btn-8f3a2c9d1e' });
  ok(genId.score < 20, 'relocate: a generated id is weak evidence and a role mismatch costs', genId);

  const hidden = c.relocate(want, [cand({ ref: 'h', tag: 'input', type: 'text', labelText: 'Full name', name: 'fullname', visible: false })]);
  ok(hidden.confidence === 'low', 'relocate: hidden elements are not candidates', hidden);

  const nothing = c.relocate(want, []);
  ok(nothing.confidence === 'low' && /no visible/.test(nothing.reason), 'relocate: an empty page says so');
}

// ── Recording → steps ──
const U = 'http://127.0.0.1:5000';
{
  const t = (o) => ({ tag: 'input', type: 'text', form: 'request', css: `#${o.id}`, ...o });
  const events = [
    { kind: 'type', at: 1, url: `${U}/form`, target: t({ id: 'fullname', name: 'fullname', labelText: 'Full name' }), value: 'Ada' },
    { kind: 'type', at: 2, url: `${U}/form`, target: t({ id: 'fullname', name: 'fullname', labelText: 'Full name' }), value: 'Ada Lovelace' },
    { kind: 'type', at: 3, url: `${U}/form`, target: t({ id: 'pin', name: 'pin', type: 'password', labelText: 'Account PIN' }), value: 'hunter2-should-never-appear' },
    { kind: 'type', at: 4, url: `${U}/form`, target: t({ id: 'cc', name: 'cc', labelText: 'Card number', autocomplete: 'cc-number' }), value: '4111111111111111' },
    { kind: 'select', at: 5, url: `${U}/form`, target: { tag: 'select', name: 'plan', labelText: 'Plan', form: 'request', css: '#plan' }, value: 'pro', optionText: 'Professional' },
    { kind: 'click', at: 6, url: `${U}/form`, target: { tag: 'input', type: 'checkbox', labelText: 'Urgent', form: 'request', css: '#urgent', checked: true }, checked: true },
    { kind: 'click', at: 7, url: `${U}/form`, target: { tag: 'button', type: 'submit', text: 'Continue', form: 'request', css: '#go' } },
    { kind: 'upload', at: 8, url: `${U}/step2`, target: { tag: 'input', type: 'file', labelText: 'Screenshot', css: '#shot' }, files: 1 },
    { kind: 'navigate', at: 9, url: 'http://other.test/elsewhere' },
  ];
  const d = c.buildDraftSteps(events, { url: `${U}/form` }, `${U}/done`);
  const acts = d.steps.flatMap(s => s.actions);
  const json = JSON.stringify(d);
  ok(d.steps[0].actions[0].kind === 'navigate' && d.steps[0].actions[0].url === `${U}/form`, 'record: the first step opens the start page');
  ok(acts.filter(a => a.kind === 'type').length === 1 && acts.find(a => a.kind === 'type').value === 'Ada Lovelace', 'record: typing in one field folds into its last value');
  ok(!json.includes('hunter2') && !json.includes('4111111111111111'), 'record: neither the password nor the card number survives, though the page sent them');
  const secrets = acts.filter(a => a.kind === 'secret');
  ok(secrets.length === 2 && secrets[0].secret.kind === 'password' && secrets[0].secret.param && secrets[1].secret.kind === 'card' && !secrets[1].secret.param, 'record: password → a credential-name parameter; card → always the person', secrets);
  ok(acts.find(a => a.kind === 'type').param === 'full_name', 'record: typed text becomes a parameter named after its label');
  const cont = acts.find(a => a.kind === 'click' && a.target.name === 'Continue');
  ok(cont.expect?.url === `${U}/step2`, 'record: a click that led to the next page expects that page', cont.expect);
  const box = acts.find(a => a.kind === 'click' && a.target.role === 'checkbox');
  ok(box.expect?.checked === true, 'record: a ticked checkbox expects to be ticked', box.expect);
  const up = acts.find(a => a.kind === 'upload');
  ok(up.value === `{{${up.param}}}` && /file/.test(up.param), 'record: an upload is a file-path parameter', up);
  ok(acts.at(-1).kind === 'navigate' && acts.at(-1).url === 'http://other.test/elsewhere', 'record: the person\'s own navigation is a step');
  ok(d.notes.some(n => /password field/.test(n)) && d.notes.some(n => /payment card/.test(n)), 'record: notes tell the person what was not recorded', d.notes);
  ok(d.steps.every(s => s.title && s.intent), 'record: every step has a title and an intent');

  // ── Saving ──
  const draft = { origin: U, startUrl: `${U}/form` };
  const steps = d.steps.map(({ shots, ...s }) => s);
  const req = { draftId: 'x', name: 'Support Request!', goal: 'Submit a support request for a customer', steps: steps.slice(0, 8) };
  const r = c.prepareProcedure(req, draft, new Date('2026-10-03T00:00:00Z'));
  ok(r.errors.length === 0 && r.procedure?.name === 'support-request', 'save: the name becomes a valid skill name', r.errors);
  const p = r.procedure;
  const full = p.params.find(x => x.name === 'full_name');
  ok(full && full.default === 'Ada Lovelace' && !full.required, 'save: a parameter keeps what was typed as its default', full);
  ok(p.steps.flatMap(s => s.actions).find(a => a.kind === 'type').value === '{{full_name}}', 'save: the step types the parameter, not the literal');
  const cred = p.params.find(x => x.kind === 'secret');
  ok(cred && cred.default === undefined && !cred.required, 'save: the credential parameter is optional and never has a default', cred);

  const unmarked = steps.map(s => ({ ...s, actions: s.actions.map(a => (a.kind === 'type' ? { ...a, param: undefined, value: 'Literal Name' } : a)) }));
  const r2 = c.prepareProcedure({ ...req, steps: unmarked.slice(0, 8) }, draft);
  ok(r2.procedure.steps.flatMap(s => s.actions).find(a => a.kind === 'type').value === 'Literal Name' && !r2.procedure.params.some(x => x.name === 'full_name'), 'save: an unmarked value is typed literally');

  // A tampered review that puts a value on a password field is turned back into a secret.
  const tampered = steps.map(s => ({ ...s, actions: s.actions.map(a => (a.kind === 'secret' && a.secret.kind === 'password' ? { kind: 'type', target: a.target, value: 'hunter2', origin: U } : a)) }));
  const r3 = c.prepareProcedure({ ...req, steps: tampered.slice(0, 8) }, draft);
  ok(!JSON.stringify(r3.procedure).includes('hunter2') && r3.procedure.steps.flatMap(s => s.actions).some(a => a.kind === 'secret' && a.secret.kind === 'password'), 'save: a value put on a password field is dropped and the step stays a secret');

  const r4 = c.prepareProcedure({ ...req, steps }, draft);
  ok(r4.errors.some(e => /outside/.test(e)), 'save: a step that opens another site is refused', r4.errors);
  ok(c.prepareProcedure({ ...req, goal: 'x' }, draft).errors.some(e => /goal/.test(e)), 'save: a goal is required');
  ok(c.prepareProcedure({ ...req, name: '!!!' }, draft).errors.some(e => /name/.test(e)), 'save: a name is required');
  const badParam = steps.map(s => ({ ...s, actions: s.actions.map(a => (a.kind === 'type' ? { ...a, param: 'bad name!' } : a)) }));
  ok(c.prepareProcedure({ ...req, steps: badParam.slice(0, 8) }, draft).errors.some(e => /parameter name/.test(e)), 'save: a bad parameter name is refused');

  // ── The skill ──
  const sk = c.procedureSkill(p);
  ok(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(sk.name) && !/[<>]/.test(sk.description) && sk.description.length <= 1000, 'skill: name and description pass the skill checker', sk.description);
  ok(/browser_run_procedure/.test(sk.body) && /full_name/.test(sk.body), 'skill: the body says how to run it and with which parameters');
  // verifySkillDir treats `dir/file.ext` in the body as a file the skill must ship.
  ok(![...sk.body.matchAll(/(?<![\w/.\\])([\w.-]+\/[\w./-]+\.[A-Za-z0-9]{1,6})/g)].length, 'skill: the body names no path the checker would look for');
  ok(!sk.json.includes('hunter2') && !sk.json.includes('4111'), 'skill: procedure.json holds no secret');
  const back = c.parseProcedure(sk.json);
  ok(back && back.steps.length === p.steps.length, 'skill: procedure.json reads back');
  ok(c.parseProcedure(JSON.stringify({ ...p, kind: 'other' })) === null && c.parseProcedure(JSON.stringify({ ...p, origin: 'https://evil.test' })) === null && c.parseProcedure('{') === null, 'skill: a foreign or inconsistent procedure.json is refused');
  ok(c.skillName('  Teach: Ünïcode Form!! ') === 'teach-unicode-form', 'skill: names are normalised', c.skillName('  Teach: Ünïcode Form!! '));
}

// ── Parameters at run time ──
{
  const proc = { params: [
    { name: 'full_name', label: 'Full name', kind: 'text', default: 'Ada', required: false },
    { name: 'email', label: 'Email', kind: 'text', required: true },
    { name: 'credential', label: 'cred', kind: 'secret', required: false },
  ] };
  const a = c.resolveParams(proc, { email: 'a@b.test', Full_Name: 'Grace Hopper', colour: 'red' });
  ok(a.values.full_name === 'Grace Hopper' && a.values.email === 'a@b.test' && !a.missing.length, 'params: given values win (names are case-insensitive)', a);
  ok(a.unknown.includes('colour'), 'params: unknown names are reported');
  const b = c.resolveParams(proc, {});
  ok(b.missing.includes('email') && b.values.full_name === 'Ada' && !('credential' in b.values), 'params: a default fills in, a required one is missing, a secret is never defaulted', b);
  ok(c.substitute('Hello {{full_name}} <{{ email }}>', { full_name: 'Grace', email: 'g@x.test' }) === 'Hello Grace <g@x.test>', 'params: substituted');
  ok(c.substitute('{{secret:grafana-admin}}', {}) === '{{secret:grafana-admin}}', 'params: a {{secret:…}} reference is never filled in');
  let threw = false; try { c.substitute('{{nope}}', {}); } catch (e) { threw = /nope/.test(e.message); }
  ok(threw, 'params: an unknown parameter is an error, not an empty string');
  ok(c.paramName({ label: 'E-mail address', role: 'textbox', name: 'x', tag: 'input' }, new Set(['e_mail_address'])) === 'e_mail_address_2', 'params: names are unique');
}

// ── The page script ──
{
  const src = pg.aicoTeachPage.toString();
  ok(!/\brequire\(|\bimport\(/.test(src) && src.startsWith('function aicoTeachPage'), 'page: the teach script is self-contained (serialised with toString)');
  ok(/isTrusted/.test(src) && /secret \? (undefined|void 0)/.test(src), 'page: only trusted input is reported, and a secret field\'s value is not read');
}

const report = c.formatReport({ name: 'p', origin: U, status: 'done', total: 2, steps: [{ index: 1, title: 'Open', status: 'ok', detail: 'at x', verified: true }, { index: 2, title: 'Click', status: 'needs_judgement', detail: 'not sure' }] });
ok(/1 of 2 steps done/.test(report) && /\[ok, verified\]/.test(report) && /needs_judgement/.test(report), 'report: per-step results', report);

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(out, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
