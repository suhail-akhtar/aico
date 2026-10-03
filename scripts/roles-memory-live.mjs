/**
 * Live check of the 0.37 model-role features on real models: the vision
 * fallback, the About-you wording call, and Recall with a real embedding
 * model. COSTS MONEY (well under a cent on gpt-4o-mini + deepseek-v4-flash;
 * embeddings use a local Ollama `nomic-embed-text`, free) — run only when the
 * owner asks: `npx tsup src/test-exports.ts --format esm --outDir dist-test &&
 * node scripts/roles-memory-live.mjs`.
 *
 * Why it exists: the offline suites prove the plumbing with stubs (a stub
 * describer, a stub learner model, a stub embedder that knows the test's
 * synonyms). Whether a real vision model's description reaches a text-only
 * model usefully, whether a real model keeps to "reword only, never invent"
 * and the sensitive filter, and how much a real embedder adds to words-only
 * Recall are properties of the models — only real calls show them.
 *
 * Keys: copies the owner's `~/.aico/settings.json` into the temporary store
 * (provider keys only travel there; nothing is written back).
 */

// A store of this process's own — nothing below may touch ~/.aico. Must stay first.
import './lib/test-home.mjs';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';

const T = await import('../dist-test/test-exports.js');
const P = T.profile;
const HOME = process.env.AICO_HOME;

let passed = 0; let failed = 0; const failures = [];
const assert = (c, n) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; failures.push(n); console.log(`  ✗ ${n}`); } };
async function block(title, fn) {
  console.log(`\n══ ${title} ══`);
  try { await fn(); } catch (err) { assert(false, `${title}: threw ${err?.stack ?? err}`); }
}

const real = path.join(os.homedir(), '.aico', 'settings.json');
const base = fs.existsSync(real) ? JSON.parse(fs.readFileSync(real, 'utf8')) : {};
const settings = {
  providerInstances: base.providerInstances ?? [], providers: base.providers ?? {},
  model: 'deepseek-v4-pro',
  models: { preset: 'balanced', roles: { vision: 'gpt-4o-mini', background: 'deepseek-v4-flash', embed: 'nomic-embed-text:latest' } },
  profile: { enabled: true, work: true, browsing: true, dailyBudgetUsd: 0.02 },
};
fs.writeFileSync(path.join(HOME, 'settings.json'), JSON.stringify(settings, null, 2));
const DAY = 86_400_000; const NOW = Date.now();

// ── vision fallback ────────────────────────────────────────────────
/** A 64×32 PNG: left half red, right half blue. No dependency. */
function twoColourPng() {
  const w = 64, h = 32;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      if (x < w / 2) { raw[o] = 220; raw[o + 1] = 20; raw[o + 2] = 20; } else { raw[o] = 20; raw[o + 1] = 40; raw[o + 2] = 220; }
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

await block('Vision fallback: a text-only main model gets the image described by the vision role', async () => {
  const role = T.resolveRole('vision', { settings, mainModel: 'deepseek-v4-pro' });
  assert(role.ok && role.model === 'gpt-4o-mini', `vision role resolves to gpt-4o-mini (${role.model || role.fellBack})`);
  let usage = 0;
  const d = T.visionDescriber({ settings, mainModel: 'deepseek-v4-pro', onUsage: (i, o) => { usage += i + o; } });
  assert(Boolean(d), 'a describer is offered because deepseek-v4-pro cannot see images');
  const t0 = Date.now();
  const text = await d.describe({ id: 'live-1', mediaType: 'image/png', name: 'halves.png' }, { data: twoColourPng().toString('base64'), mediaType: 'image/png', name: 'halves.png' });
  console.log(`    description (${Date.now() - t0} ms, ${usage} tokens): ${(text ?? '').slice(0, 220).replace(/\n/g, ' ')}`);
  assert(/red/i.test(text ?? '') && /blue/i.test(text ?? ''), 'the real description names both colours');
  const note = T.describedImageNote({ id: 'live-1', mediaType: 'image/png', name: 'halves.png' }, 'gpt-4o-mini', 'deepseek-v4-pro', text ?? '');
  assert(/gpt-4o-mini/.test(note) && /deepseek-v4-pro/.test(note), 'the note says who described it and why');
});

// ── About you wording ──────────────────────────────────────────────
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-live-proj-'));
fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'shop', dependencies: { react: '^19', express: '^5' }, devDependencies: { vite: '^7' } }));
const sessionDir = path.join(HOME, 'projects', Buffer.from(project).toString('base64').replace(/[/+=]/g, '_'), 'sessions');
fs.mkdirSync(sessionDir, { recursive: true });
for (let d = 1; d <= 3; d++) {
  const start = new Date(NOW - d * DAY); start.setHours(19, 0, 0, 0);
  const lines = [JSON.stringify({ type: '__header__', version: 1, id: `s${d}`, cwd: project, startedAt: start.getTime() })];
  let seq = 0;
  const ev = (type, data, t) => lines.push(JSON.stringify({ seq: seq++, type, timestamp: t, data }));
  ev('request/header', { header: { provider: 'deepseek', model: 'deepseek-v4-flash', systemHash: 'x', tools: [] }, reason: 'initial' }, start.getTime());
  for (let i = 0; i < 6; i++) {
    const t = start.getTime() + i * 60_000;
    ev('user/message', { turn: i + 1, content: 'fix the cart total bug in checkout', source: { kind: 'human' } }, t);
    ev('tool/call', { turn: i + 1, step: 1, callId: `c${i}`, name: 'Edit', arguments: JSON.stringify({ file_path: path.join(project, 'src', `cart-${i}.ts`), old_string: 'a', new_string: 'b' }) }, t);
    ev('tool/call', { turn: i + 1, step: 2, callId: `d${i}`, name: 'Bash', arguments: JSON.stringify({ command: 'pnpm test && git status' }) }, t);
  }
  fs.writeFileSync(path.join(sessionDir, `s${d}.events.jsonl`), lines.join('\n') + '\n');
}
const digestFile = path.join(HOME, 'desktop', 'browser', 'profile-digest.json');
fs.mkdirSync(path.dirname(digestFile), { recursive: true });
const hours = new Array(24).fill(0); hours[9] = 20; hours[10] = 12;
fs.writeFileSync(digestFile, JSON.stringify({
  v: 1, at: NOW - 3600_000, windowDays: 30,
  domains: [
    { domain: 'github.com', category: 'code hosting', minutes: 300, visits: 80, days: 20 },
    { domain: 'python.org', category: 'developer docs', minutes: 120, visits: 30, days: 9 },
    { domain: 'webmd.com', category: 'reference', minutes: 50, visits: 9, days: 6 },
  ],
  categories: [{ category: 'code hosting', minutes: 300, visits: 80 }, { category: 'developer docs', minutes: 120, visits: 30 }, { category: 'health', minutes: 40, visits: 12 }],
  threads: [{ terms: ['asyncio', 'timeout', 'python'], pages: 7, sites: 3, last: NOW - DAY }, { terms: ['church', 'service'], pages: 5, sites: 2, last: NOW - DAY }],
  searchTerms: [{ term: 'asyncio', count: 6 }, { term: 'react', count: 4 }, { term: 'diabetes', count: 9 }],
  routines: { hours, weekdays: [1, 6, 6, 6, 6, 6, 1] },
  reading: { pages: 40, medianSeconds: 25, skim: 30, partial: 5, read: 5, style: 'skims' },
  kinds: { docs: 20, code: 12, video: 2 },
  dropped: { sensitive: 3, excluded: 1 },
}));

await block('About you: one real call rewords the facts, invents nothing, keeps sensitive things out', async () => {
  const out = await P.runProfileLearner({ now: NOW, digestFile });
  const facts = P.loadProfileStore().facts;
  console.log(`    via ${out.via} · ${facts.length} facts · note: ${out.note ?? '-'}`);
  for (const f of facts.slice(0, 12)) console.log(`      [${f.category}] ${f.text}`);
  assert(out.via !== 'deterministic' && out.via !== 'skipped', `the background model was used (${out.via})`);
  assert(facts.length >= 4, `facts were written (${facts.length})`);
  assert(!/webmd|diabet|church|health|relig/i.test(JSON.stringify(facts)), 'nothing sensitive reached the facts');
  assert(facts.some(f => /typescript|react|pnpm|python/i.test(f.text)), 'the facts are about the person\'s real stack');
});

// ── Recall with a real embedding model ──────────────────────────────
await block('Recall: words only vs a real local embedding model (nomic-embed-text)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aico live recall '));
  const answers = {
    deploy: 'Deployments happen on Fridays after 2pm',
    billing: 'Invoices are generated by Stripe at month end',
    review: 'Code review is required from Aisha before merge',
    secrets: 'Secrets are rotated quarterly through the vault',
    theme: 'The UI theme supports dark mode; colors come from tokens.css',
    staging: 'Staging lives at staging.example.test behind the VPN',
  };
  const filler = ['The API uses Hono on node:sqlite', 'Logs go to stdout in JSON', 'Feature flags live in LaunchDarkly', 'The mobile app is React Native',
    'Use zod for request validation', 'Emails are sent through Postmark', 'Search is powered by Meilisearch', 'Error tracking goes to Sentry',
    'Prefer named exports over default exports', 'Tests use vitest with in-memory databases', 'Passwords are hashed with argon2', 'Pagination is cursor based'];
  for (const t of [...Object.values(answers), ...filler]) T.remember(t, 'project', { belongsTo: dir });
  T.syncAll({ projectRoots: [dir] });
  const id = (text) => `memory:${T.listScope('project', dir).find(m => m.text === text).file}`;
  const queries = [
    { q: 'how do we bill customers', want: id(answers.billing) },
    { q: 'when can we ship to production', want: id(answers.deploy) },
    { q: 'who approves pull requests', want: id(answers.review) },
    { q: 'how often are api keys changed', want: id(answers.secrets) },
    { q: 'night mode colours', want: id(answers.theme) },
    { q: 'pre-production environment address', want: id(answers.staging) },
  ];
  const embedder = T.embedderFromSettings(settings, 'deepseek-v4-pro');
  assert(Boolean(embedder), 'the embed role gives an embedder (local Ollama)');
  const run = async (e) => { let hits = 0; for (const { q, want } of queries) { const r = await T.searchRecall({ query: q, cwd: dir, limit: 3, ...(e ? { embedder: e } : {}) }); if (r.hits.slice(0, 3).some(h => h.item.id === want)) hits++; } return hits; };
  const words = await run(undefined);
  const res = await T.embedPending(embedder, { budgetMs: 60_000, max: 1000 });
  if (res.error) console.log(`    embedding error: ${res.error}`);
  const n = res.embedded ?? res;
  const hybrid = await run(embedder);
  console.log(`    ${n} items embedded · paraphrase queries hit@3: words only ${words}/6, with nomic-embed-text ${hybrid}/6`);
  assert((n.embedded ?? n) >= 18, 'every memory got a vector');
  assert(hybrid > words, `a real embedding model finds paraphrases words miss (${hybrid}/6 vs ${words}/6)`);
  T.closeRecall();
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  ✗ ${f}`); process.exit(1); }
process.exit(0);
