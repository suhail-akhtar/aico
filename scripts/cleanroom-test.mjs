/**
 * Clean-room reconstruction, end to end on real local targets (ADR 0041).
 *
 * Each target kind gets the whole pipeline: observe a real program, synthesize
 * a spec, check the spec firewall, then twin-test an identical clone (must be
 * 100%) and a deliberately wrong clone (must be caught, on the right field).
 * The web section needs Chrome or Edge and is skipped, loudly, without one.
 * No model is called: the implementer is exercised up to its brief.
 */
import './lib/test-home.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import * as T from '../dist-test/test-exports.js';

const C = T.cleanroom;
let passed = 0, failed = 0;
const assert = (c, m, extra) => { if (c) { passed++; console.log(`  ok    ${m}`); } else { failed++; console.log(`  FAIL  ${m}`, extra === undefined ? '' : JSON.stringify(extra).slice(0, 300)); } };
const section = (t) => console.log(`\n── ${t} ──`);
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `cleanroom-${n}-`));

// ── pure pieces ───────────────────────────────────────────────────────────────
section('terminal screen');
{
  const s = C.renderScreen('hello\r\nworld\x1b[2;1H\x1b[KWORLD2\x1b[1;31mred\x1b[0m', 20, 5);
  assert(s.rows[0] === 'hello' && s.rows[1] === 'WORLD2red', 'cursor moves and erase are applied, colours ignored', s.rows);
  const t = C.renderScreen('\x1b[?1049h\x1b[2J\x1b[3;4Hmenu\x1b[H> go', 20, 6);
  assert(t.rows[0] === '> go' && t.rows[2] === '   menu', 'alternate screen and absolute positioning', t.rows);
  assert(C.stripAnsi('\x1b[31mred\x1b[0m \x1b]0;title\x07ok') === 'red ok', 'stripAnsi removes CSI and OSC');
  assert(C.renderScreen('a'.repeat(25), 10, 3).rows.join('|') === 'aaaaaaaaaa|aaaaaaaaaa|aaaaa', 'long lines wrap at the column');
}

section('help parsing, paths, schemas');
{
  const h = C.parseHelp(['Usage: tool [options] <command>', '', 'Options:', '  -v, --verbose          chatty output', '  --name <value>         who to greet', '', 'Commands:', '  greet <name>           say hello', '  list                   show all', ''].join('\n'));
  assert(h.commands.join() === 'greet,list', 'subcommands read from a Commands section', h);
  assert(h.flags.some(f => f.name === '--name' && f.takesValue) && h.flags.some(f => f.name === '--verbose' && !f.takesValue), 'flags and whether they take a value', h.flags);
  assert(C.templatePath('/users/42/orders/7?x=1') === '/users/{id}/orders/{id}' && C.templatePath('/a/b') === '/a/b', 'numeric ids become {id}');
  const a = C.inferSchema({ id: 1, name: 'x', tags: ['a'], at: '2026-10-01T00:00:00Z' });
  const m = C.mergeSchema(a, C.inferSchema({ id: 2, name: null, extra: true, tags: [], at: '2026-10-02T00:00:00Z' }));
  assert(a.properties.at.format === 'date-time' && m.required.includes('id') && !m.required.includes('extra') && m.properties.extra.type === 'boolean', 'schema inference and merge (required = in every sample)', m);
  assert(C.pathsIn('{"next":"/items?page=2","self":"http://h.test/items/3","img":"/logo.png"}', 'http://h.test').sort().join() === '/items/3,/items?page=2', 'links found in JSON, static assets skipped');
}

section('pixel comparison');
{
  const png = (w, h, f) => {
    const raw = Buffer.alloc((w * 4 + 1) * h);
    for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; for (let x = 0; x < w; x++) { const [r, g, b] = f(x, y); const i = y * (w * 4 + 1) + 1 + x * 4; raw[i] = r; raw[i + 1] = g; raw[i + 2] = b; raw[i + 3] = 255; } }
    const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const crcBuf = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(crcBuf) : 0); return Buffer.concat([len, crcBuf, crc]); };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
    return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
  };
  const base = png(64, 48, (x, y) => (x < 32 ? [240, 240, 240] : [30, 30, 30]));
  const same = C.comparePng(base, png(64, 48, (x, y) => (x < 32 ? [240, 240, 240] : [30, 30, 30])));
  assert(same.comparable && same.ssim > 0.999 && same.changed === 0, 'identical images: ssim 1, nothing changed', same);
  const shifted = C.comparePng(base, png(64, 48, (x, y) => (x < 40 ? [240, 240, 240] : [30, 30, 30])));
  assert(shifted.ssim < 0.99 && shifted.changed > 0.1, 'a moved edge lowers ssim and counts changed pixels', shifted);
  const recol = C.comparePng(base, png(64, 48, (x, y) => (x < 32 ? [240, 240, 240] : [200, 30, 30])));
  assert(recol.changed > 0.4, 'a changed colour is counted', recol);
  assert(!C.comparePng(base, png(32, 48, () => [0, 0, 0])).comparable, 'different sizes are reported as not comparable');
  assert(!C.comparePng(new Uint8Array([1, 2, 3]), base).comparable, 'garbage is reported, not thrown');
}

// ── a CLI target, its clone, and a wrong clone ────────────────────────────────
const cliDir = tmp('cli');
const cliSource = (variant) => `
const [,, ...args] = process.argv;
const help = \`Usage: greeter <command> [options]

Greets people.

Options:
  --version              print the version
  --shout                upper-case the greeting

Commands:
  greet <name>           say hello to someone
  count                  count the lines on stdin
\`;
if (args.length === 0 || args[0] === '--help' || args[0] === 'help' || args[0] === '-h') { process.stdout.write(help); process.exit(0); }
if (args[0] === '--version') { console.log('greeter ${variant === 'wrong' ? '2.0.0' : '1.4.2'}'); process.exit(0); }
if (args[0] === 'greet' && args[1] === '--help') { console.log('Usage: greeter greet <name>\\n\\nSay hello to someone.\\n\\nOptions:\\n  --shout                upper-case the greeting'); process.exit(0); }
if (args[0] === 'greet') { if (!args[1]) { console.error('error: missing <name>'); process.exit(2); } const t = 'Hello, ' + args[1] + '!'; console.log(args.includes('--shout') ? t.toUpperCase() : t); process.exit(0); }
if (args[0] === 'count') { let n = 0; process.stdin.on('data', d => { n += String(d).split('\\n').filter(Boolean).length; }); process.stdin.on('end', () => { console.log(String(n)); }); }
else { console.error('error: unknown command ' + args[0]); process.exit(${variant === 'wrong' ? 1 : 2}); }
`;
fs.writeFileSync(path.join(cliDir, 'target.mjs'), cliSource('target'));
fs.writeFileSync(path.join(cliDir, 'clone.mjs'), cliSource('clone'));
fs.writeFileSync(path.join(cliDir, 'wrong.mjs'), cliSource('wrong'));
const cli = (f) => ({ kind: 'cli', command: process.execPath, args: [path.join(cliDir, f)] });

section('CLI: observe, synthesize, firewall, twin');
let cliSpec;
{
  const j = await C.explore('cli-greeter', cli('target.mjs'), { maxSteps: 40 });
  const runs = j.steps.filter(s => s.stimulus.type === 'run');
  assert(runs.length >= 8, 'the explorer ran help, version, subcommands, flags and an error case', runs.map(s => s.stimulus.args.join(' ')));
  assert(runs.some(s => s.stimulus.args.join(' ') === 'greet --help' && /Say hello/.test(s.observation.stdout)), 'it followed a subcommand into its own help');
  assert(runs.some(s => s.observation.exitCode === 2 && /unknown command|missing/.test(s.observation.stderr)), 'the error path was recorded with its exit code and stderr');
  cliSpec = C.synthesize(j);
  const names = cliSpec.cli.commands.map(c => c.path.join(' '));
  assert(names.includes('') && names.includes('greet'), 'the spec lists the root command and greet', names);
  assert(cliSpec.cli.commands.find(c => c.path.length === 0).flags.some(f => f.name === '--shout'), 'flags are in the spec');
  assert(cliSpec.cli.cases.some(c => c.args[0] === '--version' && /1\.4\.2/.test(c.stdout)), 'observed cases carry the exact output');
  assert(cliSpec.unknowns.some(u => /terminal/.test(u)), 'the spec says what it could not observe (no real terminal)');
  assert(C.synthesize(j, cliSpec.createdAt).version === 1 && JSON.stringify(C.synthesize(j, cliSpec.createdAt)) === JSON.stringify(cliSpec), 'synthesis is deterministic');

  const ws = path.join(tmp('ws'), 'w');
  const { brief } = C.prepareWorkspace(cliSpec, ws);
  assert(C.assertSpecOnly(ws, C.corpusDir('cli-greeter')).ok, 'the implementer workspace is spec-only');
  assert(!brief.includes(cliDir) && !fs.readFileSync(path.join(ws, 'spec', 'SPEC.md'), 'utf8').includes('target.mjs'), 'neither the brief nor the spec names where the target lives');
  fs.writeFileSync(path.join(ws, 'journey.jsonl'), 'x');
  assert(!C.assertSpecOnly(ws).ok, 'a stray file in the workspace is caught by the firewall check');

  const same = await C.twinTest({ journey: j, clone: cli('clone.mjs') });
  assert(same.parity === 1 && same.differences.length === 0, 'an identical clone has 100% parity', C.renderTwinReport(same));
  const wrong = await C.twinTest({ journey: j, clone: cli('wrong.mjs') });
  assert(wrong.parity < 1 && wrong.differences.some(d => d.field === 'stdout') && wrong.differences.some(d => d.field === 'exitCode'), 'a wrong clone is caught on stdout and exit code', wrong.differences.map(d => d.field));
  const live = await C.twinTest({ journey: j, clone: cli('clone.mjs'), mode: 'live', maxSteps: 6 });
  assert(live.parity === 1, 'live dual-execution agrees on an identical clone');
}

section('CLI: interactive stdin and signals');
{
  const sb = new C.CliSandbox();
  await sb.start({ kind: 'cli', command: process.execPath, args: [], interactive: true });
  await sb.inject({ type: 'run', args: ['-e', "process.stdin.on('data',d=>process.stdout.write('got:'+d)); process.on('SIGTERM',()=>{process.stdout.write('bye');process.exit(0)}); process.stdout.write('ready\\n')"] });
  assert((await sb.observe()).stdout === 'ready\n' && (await sb.observe()).exitCode === undefined, 'a program that keeps running stays alive and is observed');
  await sb.inject({ type: 'stdin', data: 'hi\n' });
  assert((await sb.observe()).stdout.includes('got:hi'), 'stdin reaches the live process');
  await sb.inject({ type: 'signal', signal: 'SIGTERM' });
  const o = await sb.observe();
  // Windows has no POSIX signals: SIGTERM ends the process outright, so no handler runs there.
  assert(process.platform === 'win32' ? o.signal === 'SIGTERM' && o.exitCode === null : o.stdout.endsWith('bye') && o.exitCode === 0, 'a signal is delivered and the exit is recorded', o);
  await sb.stop();
}

// ── an API target, a clone and a wrong clone ──────────────────────────────────
const apiServer = (variant) => http.createServer((req, res) => {
  const send = (status, body, type = 'application/json') => { res.writeHead(status, { 'content-type': type }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/health') return send(200, { ok: true, at: new Date().toISOString() });
  if (u.pathname === '/openapi.json') return send(200, { paths: { '/items': { get: {} } } });
  if (u.pathname === '/items' && req.method === 'GET') return send(200, { items: [{ id: 1, name: 'bolt', links: { self: '/items/1' } }, { id: 2, name: 'nut', links: { self: '/items/2' } }] });
  const m = /^\/items\/(\d+)$/.exec(u.pathname);
  if (m && req.method === 'GET') return +m[1] <= 2 ? send(200, { id: +m[1], name: m[1] === '1' ? 'bolt' : 'nut', price: variant === 'wrong' ? '1.50' : 1.5 }) : send(404, { error: 'not found' });
  send(404, { error: 'not found' });
});
const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
section('API: observe, synthesize, twin');
{
  const target = apiServer('target'), clone = apiServer('clone'), wrong = apiServer('wrong');
  const [pt, pc, pw] = await Promise.all([listen(target), listen(clone), listen(wrong)]);
  const base = (p) => ({ kind: 'api', baseUrl: `http://127.0.0.1:${p}` });
  const j = await C.explore('api-items', base(pt), { maxSteps: 40 });
  const spec = C.synthesize(j);
  const ops = spec.api.operations.map(o => `${o.method} ${o.path}`);
  assert(ops.includes('GET /items') && ops.includes('GET /items/{id}') && ops.includes('GET /health'), 'operations found by following links and the OpenAPI document', ops);
  const one = spec.api.operations.find(o => o.path === '/items/{id}' && o.method === 'GET');
  assert(one.responses.some(r => r.status === 200 && r.schema.properties.price.type === 'number') && one.responses.some(r => r.status === 404), 'response schemas per status', one.responses);
  assert(C.forImplementer(spec).api.baseUrl === '<BASE_URL>' && !C.renderMarkdown(C.forImplementer(spec)).includes(`${pt}`), 'the target address does not cross the firewall');
  const same = await C.twinTest({ journey: j, clone: base(pc) });
  assert(same.parity === 1, 'an identical API clone has 100% parity (timestamps scrubbed)', C.renderTwinReport(same));
  const bad = await C.twinTest({ journey: j, clone: base(pw) });
  assert(bad.parity < 1 && bad.differences.some(d => d.field === 'body'), 'a clone returning price as a string is caught in the body', bad.differences.map(d => d.field));
  target.close(); clone.close(); wrong.close();
}

// ── a web target (needs a browser) ────────────────────────────────────────────
let haveBrowser = false;
try { const sb = new C.WebSandbox(); const s0 = http.createServer((_, r) => { r.end('<title>x</title>'); }); const p0 = await listen(s0); await sb.start({ kind: 'web', url: `http://127.0.0.1:${p0}/`, timeoutMs: 20000 }); haveBrowser = true; await sb.stop(); s0.close(); } catch { haveBrowser = false; }
const site = (variant) => http.createServer((req, res) => {
  const page = (title, body, extra = '') => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<!doctype html><html><head><title>${title}</title><style>body{font-family:Georgia,serif;margin:0;background:${variant === 'wrong' ? '#fff3e0' : '#f4f6fb'};color:#1a2233} header{background:#1b3a6b;color:#fff;padding:16px 24px} main{padding:24px} a,button{background:#1b3a6b;color:#fff;border:0;padding:8px 14px;border-radius:6px;text-decoration:none;font-size:15px}</style></head><body><header><nav role="navigation"><a href="/">Home</a> <a href="/about">About</a> <a href="/contact">Contact</a></nav></header><main>${body}</main>${extra}</body></html>`); };
  if (req.url === '/') return page('Acme Home', '<h1>Welcome to Acme</h1><p>Quality parts since 1999.</p>');
  if (req.url === '/about') return page('About Acme', '<h1>About us</h1><p>We make bolts and nuts.</p><button onclick="document.getElementById(\'m\').textContent=\'Thanks for clicking\'">Say thanks</button><p id="m"></p>');
  if (req.url === '/contact') return page('Contact', '<h1>Contact</h1><form action="/send" method="post"><label>Email <input name="email" type="email"></label><button type="submit">Send</button></form>');
  if (req.url === '/send' && req.method === 'POST') return page('Sent', '<h1>Message sent</h1>');
  res.writeHead(404); res.end('nope');
});
section('web: observe, synthesize, pixel twin');
if (!haveBrowser) console.log('  SKIP  no Chrome or Edge on this machine: the web adapter was not exercised');
else {
  const target = site('target'), clone = site('clone'), wrong = site('wrong');
  const [pt, pc, pw] = await Promise.all([listen(target), listen(clone), listen(wrong)]);
  const web = (p) => ({ kind: 'web', url: `http://127.0.0.1:${p}/`, timeoutMs: 20000 });
  const j = await C.explore('web-acme', web(pt), { maxSteps: 14, maxDepth: 3 });
  const spec = C.synthesize(j);
  const routes = spec.web.routes.map(r => r.path);
  assert(routes.includes('/') && routes.includes('/about') && routes.includes('/contact'), 'the crawl reached every linked page', routes);
  assert(spec.web.routes.some(r => r.path === '/send') || j.steps.some(s => (s.observation.network ?? []).some(n => n.method === 'POST')), 'the form was filled and submitted', routes);
  assert(spec.web.transitions.some(t => /click/.test(t.event)), 'transitions are State + Event -> State');
  assert(spec.web.tokens && spec.web.tokens.fonts.some(f => /Georgia/i.test(f)) && spec.web.tokens.colors.background.length > 0, 'the measured look is in the spec (fonts and colours as values)', spec.web.tokens);
  assert(spec.web.layout.some(l => l.role === 'navigation') && spec.web.viewport.width === 1280, 'layout boxes are in the spec');
  const specText = JSON.stringify(spec);
  assert(!specText.includes('"frame"') && !/<html|<script/i.test(specText), 'no frame and no markup crosses the firewall');
  assert(fs.existsSync(path.join(C.corpusDir('web-acme'), 'frames', '1.png')), 'the screenshots stay in the corpus');
  const same = await C.twinTest({ journey: j, clone: web(pc), maxSteps: 8 });
  assert(same.parity === 1, 'an identical clone matches on text, controls, effects and pixels', C.renderTwinReport(same));
  const bad = await C.twinTest({ journey: j, clone: web(pw), maxSteps: 4 });
  assert(bad.differences.some(d => d.field === 'frame') || bad.differences.some(d => d.field === 'colors'), 'a clone with a different background is caught visually', bad.differences.map(d => d.field));
  target.close(); clone.close(); wrong.close();
}

console.log(`\ncleanroom: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
