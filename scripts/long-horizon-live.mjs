/**
 * Live proof of long-horizon context management, against a real model.
 *
 * One long turn that has to read many files, one at a time, into a context
 * deliberately set small enough that it must be managed; then a second turn
 * that depends on the first. Checked against ground truth, not against what
 * the model says it did:
 *
 *   - every access code in results.json matches the file it came from,
 *   - the follow-up turn could still act on the first turn's work,
 *   - and the session log shows what the manager actually did (masks,
 *     mid-turn condensations, how each turn ended), with the tokens it cost.
 *
 * `off` runs the same task with context management and compaction disabled,
 * as the baseline the savings are measured against.
 *
 * Run: npm run test:web-build (or the tsup line below) first, then
 *   node scripts/long-horizon-live.mjs <model> [on|off]
 *
 * @module scripts/long-horizon-live
 */
import './lib/test-home.mjs';
import fs from 'fs';
import os from 'os';
import path from 'path';

for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
  if (m && m[2].trim()) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}

const MODEL = process.argv[2] ?? 'deepseek-flash';
// tight: limits forced low, to prove a run survives real pressure and stays right.
// default: the settings as they are, to measure what management costs or saves
// on an ordinary run. off: no management at all, the baseline for both.
const MODE = ['tight', 'default', 'off'].includes(process.argv[3]) ? process.argv[3] : 'tight';
const FILES = Number(process.argv[4] ?? 10);
const OUT = path.join('benchmarks', 'long-horizon', `${MODEL.replace(/[^\w.-]/g, '_')}-${MODE}-${FILES}`);
fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => { const l = `[${new Date().toISOString().slice(11, 19)}] ${a.join(' ')}`; console.log(l); fs.appendFileSync(path.join(OUT, 'run.log'), `${l}\n`); };
fs.writeFileSync(path.join(OUT, 'run.log'), '');

// ── The workspace: files that have to be read, each hiding one answer ───────
const work = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'aico-lh-'));
fs.mkdirSync(path.join(work, 'data'));
const WORDS = ['amber', 'basalt', 'cobalt', 'delta', 'ember', 'fjord', 'garnet', 'harbor', 'indigo', 'juniper', 'kestrel', 'lumen'];
const truth = {};
let seed = 7;
const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
for (let i = 1; i <= FILES; i++) {
  const name = `report-${String(i).padStart(2, '0')}.txt`;
  const code = `${WORDS[rand(WORDS.length)]}-${100 + rand(900)}${i % 3 === 0 ? `-${WORDS[rand(WORDS.length)]}` : ''}`;
  truth[name] = code;
  const lines = [];
  for (let l = 0; l < 220; l++) {
    lines.push(`Line ${l}: quarterly note ${rand(10_000)} about region ${WORDS[rand(WORDS.length)]}, status ${rand(2) ? 'green' : 'amber'}, owner team-${rand(40)}.`);
  }
  lines.splice(40 + rand(150), 0, `ACCESS CODE: ${code}`);
  fs.writeFileSync(path.join(work, 'data', name), lines.join('\n'));
}
const longest = Object.entries(truth).sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))[0][0];

// ── Settings for this run ────────────────────────────────────────────────────
const settingsFile = path.join(process.env.AICO_HOME, 'settings.json');
const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
settings.model = MODEL;
settings.autoApprove = true;
settings.workspace = { ...(settings.workspace ?? {}), path: work };
settings.safetyLimits = { maxCostPerSession: 2 };
delete settings.projects;
const writeSettings = () => fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
writeSettings();

const { serve } = await import('../dist-test/server/index.js');
const { url, close } = await serve({ port: 0 });
const token = new URL(url).searchParams.get('token');
const origin = new URL(url).origin;
const api = (p, init = {}) => fetch(`${origin}/api/${p}`, { ...init, headers: { 'Content-Type': 'application/json', 'x-aico-token': token, ...(init.headers ?? {}) } });
const json = async (p) => (await api(p)).json();

async function turn(sessionId, task, budgetMs = 1_500_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);
  const notices = [];
  let end;
  const res = await fetch(`${origin}/api/events?session=${sessionId}&since=${(await json(`session?id=${sessionId}`)).seq ?? 0}&token=${token}`,
    { signal: controller.signal, headers: { Accept: 'text/event-stream' } });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  await api('submit', { method: 'POST', body: JSON.stringify({ sessionId, task, model: MODEL }) });
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let i;
      while ((i = buffer.indexOf('\n\n')) >= 0) {
        const raw = buffer.slice(0, i); buffer = buffer.slice(i + 2);
        const line = raw.split('\n').find(l => l.startsWith('data: '));
        if (!line) continue;
        const ev = JSON.parse(line.slice(6));
        if (ev.type === 'notice') { notices.push(ev.data?.text ?? ev.text); log('  notice:', ev.data?.text ?? ev.text); }
        if (ev.type === 'turn-end') { end = ev; break; }
      }
      if (end) break;
    }
  } finally { clearTimeout(timer); await reader.cancel().catch(() => {}); }
  return { end, notices };
}

/** The session's log, from disk. */
function sessionEvents(id) {
  const root = path.join(process.env.AICO_HOME, 'projects');
  for (const dir of fs.readdirSync(root)) {
    const file = path.join(root, dir, 'sessions', `${id}.events.jsonl`);
    if (fs.existsSync(file)) {
      return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    }
  }
  return [];
}

let passed = 0, failed = 0;
const check = (cond, name) => { if (cond) { passed++; log('  ✓', name); } else { failed++; log('  ✗', name); } };

// ── Warm-up: how big is the fixed part of a request on this model? ──────────
const warm = `lh-warm-${Date.now()}`;
await turn(warm, 'Reply with just: ok');
const warmUsage = sessionEvents(warm).filter(e => e.type === 'assistant/message' && e.data.usage).map(e => e.data.usage.inputTokens);
const overhead = Math.max(...warmUsage, 1);
log(`model ${MODEL}, mode ${MODE}; fixed request overhead ~${overhead} tokens`);

// Small enough that ten ~9K-char files cannot all stay in view: the history
// may grow to ~16K tokens above the fixed overhead before compacting.
if (MODE === 'tight') {
  settings.autoCompact = { thresholdTokens: overhead + 16_000, keepRecentTurns: 1 };
  settings.contextManagement = { enabled: true, maskAtTokens: overhead + 8_000, keepRecentToolResults: 3, keepRecentSteps: 3 };
} else if (MODE === 'off') {
  settings.autoCompact = { enabled: false };
  settings.contextManagement = { enabled: false };
} else {
  delete settings.contextManagement;
}
writeSettings();

// ── The long turn ────────────────────────────────────────────────────────────
const sessionId = `lh-${MODE}-${Date.now()}`;
const started = Date.now();
const first = await turn(sessionId, [
  `The folder data/ holds ${FILES} report files. Each contains exactly one line that starts with "ACCESS CODE:".`,
  'Read every file with the Read tool, one file per step — do not use Grep, Glob patterns on contents, or Bash to search them;',
  'the point is to read each one. Track your progress with TodoWrite.',
  // "The workspace root" read two ways: gpt-6-luna took it as AICO's own
  // scratch area (WorkspaceWrite) and the file never reached this folder.
  'When all are read, use the Write tool to create results.json in the current folder, next to data/:',
  'a JSON object mapping each file name (e.g. "report-01.txt") to its access code, exactly as written.',
  'Then reply with how many codes you found.',
].join(' '));
log('turn 1 ended:', JSON.stringify(first.end?.data?.reason ?? first.end?.reason ?? first.end?.data?.error ?? null));

const results = (() => { try { return JSON.parse(fs.readFileSync(path.join(work, 'results.json'), 'utf8')); } catch { return null; } })();
const correct = results ? Object.entries(truth).filter(([f, c]) => results[f] === c).length : 0;
check(correct === FILES, `results.json holds all ${FILES} codes, each matching its file (${correct}/${FILES})`);

// ── The follow-up that depends on it ────────────────────────────────────────
const second = await turn(sessionId,
  'Add a key "total" to results.json holding how many report files you processed, and tell me which file has the longest access code.');
const after = (() => { try { return JSON.parse(fs.readFileSync(path.join(work, 'results.json'), 'utf8')); } catch { return null; } })();
check(after?.total === FILES, `the follow-up turn updated the same file correctly (total=${after?.total})`);
const events = sessionEvents(sessionId);
const lastReply = events.filter(e => e.type === 'assistant/message' && e.data.content).pop()?.data.content ?? '';
check(lastReply.includes(longest), `and named the file with the longest code (${longest})`);

// ── What the manager did, and what it cost ──────────────────────────────────
const usage = events.filter(e => e.type === 'assistant/message' && e.data.usage).map(e => e.data.usage);
const sum = (k) => usage.reduce((t, u) => t + (u[k] ?? 0), 0);
const snapshot = await json(`session?id=${sessionId}`);
const summary = {
  model: MODEL, mode: MODE, overhead,
  steps: usage.length,
  masks: events.filter(e => e.type === 'context/masked').length,
  compactions: events.filter(e => e.type === 'compaction/summary').length,
  turnEnds: events.filter(e => e.type === 'turn/end').map(e => e.data.reason),
  inputTokens: sum('inputTokens'), cachedTokens: sum('cachedTokens'), outputTokens: sum('outputTokens'),
  peakRequest: Math.max(...usage.map(u => u.inputTokens)),
  costUsd: snapshot.usage?.costUsd ?? null,
  minutes: +((Date.now() - started) / 60_000).toFixed(1),
  correct, passed, failed,
  tools: events.filter(e => e.type === 'tool/call')
    .reduce((m, e) => ({ ...m, [e.data.name]: (m[e.data.name] ?? 0) + 1 }), {}),
  notices: [...first.notices, ...second.notices],
};
if (MODE === 'tight') {
  check(summary.masks + summary.compactions > 0, `the context was actually managed (${summary.masks} mask(s), ${summary.compactions} compaction(s))`);
  check(summary.turnEnds.every(r => r.kind === 'completed'), 'both turns completed normally');
}
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(summary, null, 2));
log(JSON.stringify({ ...summary, notices: summary.notices.length }));

await close();
fs.rmSync(work, { recursive: true, force: true });
log(`LONG-HORIZON ${MODEL} ${MODE}: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
