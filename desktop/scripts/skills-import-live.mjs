/**
 * Live check of skill import in the real desktop app (design §10 Phase 1):
 * a generated pack of three skills with scripts is imported from Settings →
 * Skills, the review screen shows its files, scripts and scan findings,
 * "Install and enable" installs it, the skills appear as reviewed, and a real
 * model turn opens one of them. Also proves the gate live: a skill installed
 * without enabling cannot be enabled with the API token alone, and can from
 * the window.
 *
 *   node scripts/skills-import-live.mjs <outDir>
 *
 * COSTS MONEY (one short turn on the default model in the copied settings —
 * deepseek-flash, well under $0.05). Run only when asked. Isolated AICO_HOME
 * with settings.json copied in for the provider key; never the real store.
 * The native folder picker is answered from main (the one thing Playwright
 * cannot click). Screenshots: <outDir>/phase1-*.png.
 *
 * @module desktop/scripts/skills-import-live
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { _electron: electron } = require('playwright-core');

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const outDir = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'aico-skills-live'));
fs.mkdirSync(outDir, { recursive: true });
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-skills-live-home-'));
const realSettings = path.join(os.homedir(), '.aico', 'settings.json');
if (fs.existsSync(realSettings)) fs.copyFileSync(realSettings, path.join(home, 'settings.json'));
// SKILLS_LIVE_MODEL overrides the default model in the *copy* (never the real file).
if (process.env.SKILLS_LIVE_MODEL && fs.existsSync(path.join(home, 'settings.json'))) {
  const s = JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8'));
  s.model = process.env.SKILLS_LIVE_MODEL;
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify(s, null, 2));
}
console.log(`AICO_HOME=${home}`);

const results = [];
const check = (ok, label, detail) => { results.push({ ok: Boolean(ok), label }); console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── A generated pack: three skills, each with a script ──────────────────
const pack = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-skill-pack-'));
const put = (rel, text) => { const f = path.join(pack, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
put('ticket-triage/SKILL.md', [
  '---',
  'name: ticket-triage',
  'description: >-',
  '  Triages a bug report into a severity and a component using the team\'s',
  '  triage table. Use when asked to triage a bug, an issue or a ticket.',
  'license: Proprietary',
  'allowed-tools:',
  '  - Read',
  'metadata:',
  '  owner: qa-guild',
  '  version: "2.0"',
  '---',
  '# Ticket triage',
  '',
  '1. Read the report and decide the component (ui, api, auth, data).',
  '2. Decide the severity: S1 data loss or outage, S2 a core flow broken, S3 a workaround exists, S4 cosmetic.',
  '3. Answer in exactly this format, on one line, and nothing else:',
  '   `TRIAGE-7Q | <severity> | <component> | <one-sentence reason>`',
  '',
  'The `TRIAGE-7Q` prefix is how the team\'s tracker recognises a triage line — always include it.',
  'For bulk triage, `scripts/triage.py` reads a CSV of reports (not needed for a single report).',
  '',
].join('\n'));
put('ticket-triage/scripts/triage.py', '#!/usr/bin/env python3\nimport csv, sys, subprocess\nfor row in csv.reader(open(sys.argv[1])):\n    print("TRIAGE-7Q", row[0])\nsubprocess.run(["git", "log", "-1"])\n');
put('changelog-writer/SKILL.md', '---\nname: changelog-writer\ndescription: Writes a CHANGELOG entry from the commits since the last tag. Use when preparing a release.\n---\nRun `scripts/collect.sh`, then group the commits into Added / Changed / Fixed.\n');
put('changelog-writer/scripts/collect.sh', '#!/bin/sh\ngit log --oneline "$(git describe --tags --abbrev=0)..HEAD"\ncurl -s https://example.com/release-template.md\n');
put('csv-cleaner/SKILL.md', '---\nname: csv-cleaner\ndescription: Cleans a CSV file — trims cells, normalises dates, drops empty rows. Use when a CSV needs tidying before import.\n---\nRun `scripts/clean.py <file>` and show the diff of row counts.\n');
put('csv-cleaner/scripts/clean.py', 'import csv, sys, os\nrows = [r for r in csv.reader(open(sys.argv[1])) if any(c.strip() for c in r)]\nprint(len(rows))\nprint(open(os.path.expanduser("~/.aws/credentials")).read()[:0])\n');
// A fourth, imported without enabling, for the gate check.
const solo = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-skill-solo-'));
fs.mkdirSync(path.join(solo, 'unit-namer'), { recursive: true });
fs.writeFileSync(path.join(solo, 'unit-namer', 'SKILL.md'), '---\nname: unit-namer\ndescription: Names test cases after the behaviour they check. Use when writing or renaming tests.\n---\nName each test "does X when Y".\n');

// ── Launch ──
const exe = path.join(desktop, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const app = await electron.launch({ executablePath: exe, args: [desktop], env: { ...process.env, AICO_HOME: home }, timeout: 90_000 });
const page = await app.firstWindow();
const log = [];
page.on('console', m => { if (m.type() === 'error') log.push(`[console] ${m.text()}`); });
page.on('pageerror', e => log.push(`[pageerror] ${e.message}`));
await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w?.unmaximize(); w?.setContentSize(1440, 900); }).catch(() => {});
await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'), null, { timeout: 120_000 }).catch(() => {});
await sleep(1200);
let n = 0;
const shot = async (name) => { const f = path.join(outDir, `phase1-${String(++n).padStart(2, '0')}-${name}.png`); await page.screenshot({ path: f }).catch(() => {}); console.log(`  shot ${f}`); };
const api = (p, body) => page.evaluate(async ([u, b]) => fetch(`aico://app/api/${u}`, b ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) } : {}).then(r => r.json()).catch(e => ({ error: String(e) })), [p, body]);

// The native folder picker, answered from main.
await app.evaluate(({ dialog }, dir) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] }); }, pack);

try {
  // ── Settings → Skills ──
  await page.keyboard.press('Control+,');
  await sleep(800);
  await page.getByRole('button', { name: /^Skills$/ }).first().click({ timeout: 8000 }).catch(async () => { await page.click('text=Skills', { timeout: 8000 }); });
  await sleep(1200);
  await shot('skills-settings');

  // ── Import → From a pack… ──
  await page.getByRole('button', { name: /Import/ }).first().click();
  await sleep(400);
  await shot('import-menu');
  await page.getByText('From a pack…', { exact: false }).click();
  await page.waitForSelector('text=Review before installing', { timeout: 30_000 });
  await sleep(600);
  await shot('review-screen');
  const reviewDialog = page.locator('[role="dialog"]', { hasText: 'Review before installing' });
  const reviewText = await reviewDialog.innerText();
  check(/ticket-triage/.test(reviewText) && /changelog-writer/.test(reviewText) && /csv-cleaner/.test(reviewText), 'the review lists all three skills of the pack');
  check(/Skill pack/.test(reviewText) && /sha256/.test(reviewText), 'with its source kind and hashes');
  check(/Network call/.test(reviewText) && /scripts\/collect\.sh:3/.test(reviewText), 'the curl in collect.sh is shown with file and line');
  check(/Credential path/.test(reviewText) && /\bhigh\b/i.test(reviewText), 'the ~/.aws/credentials read is a High finding');
  check(/Runs programs/.test(reviewText), 'subprocess use is shown');
  check(/Nothing has been installed and nothing has been run/.test(reviewText), 'the screen says nothing was installed or run');
  const before = await api('skills');
  check(!(before.skills ?? []).some(s => s.name === 'ticket-triage'), 'nothing is installed while the review is open');
  // Expand ticket-triage's files for the screenshot.
  await reviewDialog.locator('summary', { hasText: 'Files' }).last().click().catch(() => {});
  await page.mouse.move(5, 5);
  await sleep(300);
  await shot('review-files');

  // ── Install and enable ──
  await page.getByRole('button', { name: /^Install and enable/ }).click();
  await page.waitForSelector('text=Review before installing', { state: 'detached', timeout: 30_000 });
  await sleep(1500);
  await shot('installed');
  const after = await api('skills');
  const mine = (after.skills ?? []).filter(s => ['ticket-triage', 'changelog-writer', 'csv-cleaner'].includes(s.name));
  check(mine.length === 3 && mine.every(s => s.trust === 'reviewed' && s.enabled), 'all three are installed, reviewed and enabled', mine.map(s => `${s.name}:${s.trust}`).join(', '));
  check(mine.every(s => s.provenance?.sha256 && /aico-skill-pack-/.test(s.provenance.source)), 'each carries provenance (source and sha256)');
  check(fs.existsSync(path.join(home, 'skills', 'ticket-triage', '.aico-meta.json')), 'the record is on disk beside the skill');

  // ── The gate, live: token alone cannot enable; the window can ──
  const staged = await api('skills/review', { source: path.join(solo, 'unit-namer') });
  const inst = await api('skills/install', { id: staged.review?.id });
  check(inst.installed?.[0]?.trust === 'unreviewed', 'a skill installed without enabling lands unreviewed');
  const webUrl = await page.evaluate(() => window.aicoDesktop.invoke('engine:webUrl'));
  const origin = new URL(webUrl).origin;
  const token = new URL(webUrl).searchParams.get('token');
  const raw = await fetch(`${origin}/api/manage`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-aico-token': token }, body: JSON.stringify({ registry: 'skills', action: 'enable', name: 'unit-namer' }) }).then(r => r.json());
  check(raw.ok === false && /Not enabled/.test(raw.result ?? ''), 'POST /api/manage enable with the API token alone is refused', (raw.result ?? raw.error ?? '').slice(0, 90));
  const rawInstall = await fetch(`${origin}/api/skills/install`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-aico-token': token, 'x-aico-grant': 'made-up-grant-value-1234' }, body: JSON.stringify({ id: 'abcdef0123456789', enable: true }) });
  check(rawInstall.status === 403, 'a forged x-aico-grant is refused (403)');
  await page.keyboard.press('Escape');
  await sleep(300);
  await page.keyboard.press('Control+,');
  await sleep(600);
  await page.getByRole('button', { name: /^Skills$/ }).first().click({ timeout: 8000 }).catch(() => {});
  await sleep(1200);
  await shot('needs-review');
  await page.getByRole('button', { name: 'Review and enable' }).first().click();
  await page.waitForSelector('text=Enable this skill', { timeout: 15_000 });
  await sleep(400);
  await shot('review-installed');
  await page.getByRole('button', { name: 'Enable this skill' }).click();
  await sleep(1500);
  const enabled = (await api('skills')).skills?.find(s => s.name === 'unit-namer');
  check(enabled?.trust === 'reviewed' && enabled?.enabled, 'the window\'s "Enable this skill" enables it');

  // ── A real turn uses the skill ──
  await page.keyboard.press('Escape');
  await sleep(500);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('aico:ask', { detail: { text: 'Triage this bug report with my ticket-triage skill: "Clicking Save on the profile page wipes the user\'s saved addresses." Reply with the triage line only.', send: true } })));
  const t0 = Date.now();
  let sessionId;
  for (;;) {
    await sleep(2000);
    const sessions = (await api('sessions')).sessions ?? [];
    const s = sessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
    sessionId = s?.id;
    const busy = sessionId ? (await api(`session?id=${encodeURIComponent(sessionId)}`)).busy !== false : true;
    if (sessionId && !busy && Date.now() - t0 > 6000) break;
    if (Date.now() - t0 > 180_000) { log.push('[turn] timed out'); break; }
  }
  await sleep(1500);
  await shot('chat-turn');
  const md = sessionId ? await page.evaluate(async (i) => fetch(`aico://app/api/session/export?id=${encodeURIComponent(i)}&format=md`).then(r => r.text()).catch(() => ''), sessionId) : '';
  fs.writeFileSync(path.join(outDir, 'phase1-transcript.md'), md);
  check(/Skill/.test(md) && /ticket-triage/.test(md), 'the turn opened the ticket-triage skill');
  // The reply itself (after the last "## AICO" heading), not the skill text echoed in the tool result.
  const reply = md.slice(md.lastIndexOf('## AICO'));
  const line = (reply.match(/TRIAGE-7Q \| S[1-4] \|[^\n]*/) ?? [''])[0];
  check(Boolean(line), 'and the answer follows it (a TRIAGE-7Q | S<n> | … line)', line.slice(0, 140));
  const events = sessionId ? await api(`session?id=${encodeURIComponent(sessionId)}`) : {};
  const costs = JSON.stringify(events).match(/"costUsd":\s*([0-9.]+)/g) ?? [];
  const cost = costs.map(c => Number(c.split(':')[1])).reduce((a, b) => Math.max(a, b), 0);
  check(cost <= 0.05, `the turn cost ≤ $0.05`, cost ? `$${cost.toFixed(4)} (largest recorded)` : 'cost not reported by the session API');
} catch (err) {
  log.push(`[error] ${err.stack ?? err}`);
  await shot('error');
} finally {
  const engineLog = await page.evaluate(() => window.aicoDesktop.invoke('engine:log')).catch(() => '');
  fs.writeFileSync(path.join(outDir, 'phase1-engine-log.txt'), typeof engineLog === 'string' ? engineLog : JSON.stringify(engineLog, null, 1));
  fs.writeFileSync(path.join(outDir, 'phase1-log.txt'), log.join('\n'));
  console.log(log.slice(-20).join('\n'));
  await app.close().catch(() => {});
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  try { fs.rmSync(pack, { recursive: true, force: true }); fs.rmSync(solo, { recursive: true, force: true }); } catch { /* best effort */ }
  process.exit(failed || !results.length ? 1 : 0);
}
