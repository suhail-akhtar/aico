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

section('CLI under a pseudo-terminal');
if (!(await C.ptyAvailable())) console.log('  SKIP  @lydell/node-pty is not installed here: the pty adapter was not exercised');
else {
  const pty = (extra = {}) => ({ kind: 'cli', command: process.execPath, args: [], pty: true, columns: 100, rows: 30, ...extra });
  let sb = new C.CliSandbox();
  await sb.start(pty());
  await sb.inject({ type: 'run', args: ['-e', "console.log('tty=' + process.stdout.isTTY + ' size=' + process.stdout.columns + 'x' + process.stdout.rows)"] });
  let o = await sb.observe();
  assert(/tty=true size=100x30/.test(C.stripAnsi(o.stdout)) && o.terminal.tty === true && o.exitCode === 0, 'the program sees a real terminal of the requested size', C.stripAnsi(o.stdout));
  await sb.stop();
  const pipe = new C.CliSandbox();
  await pipe.start({ kind: 'cli', command: process.execPath, args: [] });
  await pipe.inject({ type: 'run', args: ['-e', "console.log('tty=' + !!process.stdout.isTTY)"] });
  assert(/tty=false/.test((await pipe.observe()).stdout) && (await pipe.observe()).terminal.tty === false, 'the same program on pipes is not on a terminal, and the observation says which');
  await pipe.stop();

  sb = new C.CliSandbox();
  await sb.start(pty({ interactive: true }));
  const tui = "process.stdin.setRawMode(true); process.stdin.resume(); process.stdout.write('\x1b[2J\x1b[1;1HMENU\x1b[3;3H> one\x1b[4;3H  two'); process.stdin.on('data', d => { const k = d.toString('hex'); if (k === '03') process.exit(0); process.stdout.write('\x1b[6;1Hkey:' + k + '   '); }); process.stdout.on('resize', () => process.stdout.write('\x1b[8;1Hcols:' + process.stdout.columns + '   ')); process.on('SIGINT', () => { process.stdout.write('\x1b[9;1Hgot-sigint'); process.exit(0); });";
  await sb.inject({ type: 'run', args: ['-e', tui] });
  o = await sb.observe();
  assert(o.screen[0] === 'MENU' && o.screen[2].trim() === '> one' && o.screen[3].trim() === 'two', 'a full-screen program is read as a screen, not as raw bytes', o.screen);
  await sb.inject({ type: 'press', key: 'Enter' });
  assert((await sb.observe()).screen.some(r => r.includes('key:0d')), 'a key press arrives as the bytes a terminal sends');
  await sb.inject({ type: 'press', key: 'ArrowUp' });
  assert((await sb.observe()).screen.some(r => r.includes('key:1b5b41')), 'arrow keys arrive as escape sequences');
  await sb.inject({ type: 'resize', columns: 60, rows: 20 });
  assert((await sb.observe()).screen.some(r => r.includes('cols:60')), 'a resize reaches the program');
  assert(C.keyToSequence('ctrl+c') === '' && C.keyToSequence('F5') === '[15~' && C.keyToSequence('x') === 'x', 'key names map to terminal sequences');
  await sb.stop();

  sb = new C.CliSandbox();
  await sb.start(pty({ interactive: true }));
  await sb.inject({ type: 'run', args: ['-e', "process.on('SIGINT', () => { console.log('got-sigint'); process.exit(7); }); console.log('ready'); setInterval(() => {}, 1000);"] });
  await sb.inject({ type: 'signal', signal: 'SIGINT' });
  o = await sb.observe();
  assert(/got-sigint/.test(C.stripAnsi(o.stdout)) && o.exitCode === 7 && o.signalDelivery === 'ctrl-c', 'Ctrl-C is a real interrupt: the handler ran and chose the exit code, on every platform', o);
  await sb.stop();

  sb = new C.CliSandbox();
  await sb.start({ kind: 'cli', command: process.execPath, args: [], interactive: true });
  await sb.inject({ type: 'run', args: ['-e', "process.on('SIGTERM', () => { console.log('term-handler'); process.exit(0); }); console.log('ready'); setInterval(() => {}, 1000);"] });
  await sb.inject({ type: 'signal', signal: 'SIGTERM' });
  o = await sb.observe();
  assert(o.signalDelivery === (process.platform === 'win32' ? 'forced' : 'signal') && (process.platform === 'win32' ? !/term-handler/.test(o.stdout) : /term-handler/.test(o.stdout)), 'SIGTERM runs the handler on POSIX and is reported as forced on Windows', o);
  await sb.stop();

  const one = new C.CliSandbox();
  await one.start(pty({ interactive: true }));
  await one.inject({ type: 'run', args: ['-e', "process.stdin.setEncoding('utf8'); process.stdin.on('data', d => { if (d.includes('hello')) console.log('read:hello'); }); process.stdin.on('end', () => { console.log('eof'); process.exit(0); }); console.log('ready');"] });
  await one.inject({ type: 'stdin', data: 'hello\r' });
  assert(/read:hello/.test(C.stripAnsi((await one.observe()).stdout)), 'typed input reaches a program on a terminal');
  await one.stop();
  if (process.platform !== 'win32') {
    const eof = new C.CliSandbox();
    await eof.start(pty());
    await eof.inject({ type: 'run', args: ['-e', "let b=''; process.stdin.on('data', d => b += d); process.stdin.on('end', () => console.log('read:' + b.trim()));"], stdin: 'hello\n' });
    assert(/read:hello/.test(C.stripAnsi((await eof.observe()).stdout)) && (await eof.observe()).exitCode === 0, 'a one-shot with input ends with Ctrl-D on a terminal');
    await eof.stop();
  } else console.log('  SKIP  end-of-input on a Windows pseudo-terminal: Node does not treat Ctrl-Z as EOF there (documented limit)');
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

// ── coverage, resume, the guide, the clone-side spec diff ─────────────────────
section('coverage, resume and refusing to overwrite');
{
  const j1 = await C.explore('cov-greeter', cli('target.mjs'), { maxSteps: 4 });
  const s1 = C.readExplorerState('cov-greeter');
  assert(j1.steps.length === 4 && s1.stoppedBy === 'budget' && s1.pending.length > 0, 'a run that hits its budget says it stopped there and what is left', { steps: j1.steps.length, pending: s1.pending.length });
  assert(/left unvisited \(resume to continue\)/.test(C.coverageLine(s1)), 'the coverage line says how much is untried', C.coverageLine(s1));
  const spec1 = C.synthesize(j1, undefined, s1);
  assert(spec1.coverage.ratio < 1 && spec1.coverage.pending.length > 0 && spec1.unknowns.some(u => /unvisited/.test(u)), 'the spec carries the coverage ratio, the frontier and an unknown about it', spec1.coverage);
  let refused = false;
  try { await C.explore('cov-greeter', cli('target.mjs'), { maxSteps: 4 }); } catch (e) { refused = /already holds 4 recorded step/.test(String(e.message)); }
  assert(refused, 'recording over an existing id is refused instead of mixing two runs');
  const created = JSON.parse(fs.readFileSync(path.join(C.corpusDir('cov-greeter'), 'meta.json'), 'utf8')).createdAt;
  const j2 = await C.explore('cov-greeter', cli('target.mjs'), { maxSteps: 40, resume: true });
  const s2 = C.readExplorerState('cov-greeter');
  assert(j2.steps.length > 4 && s2.stoppedBy === 'complete' && s2.pending.length === 0, 'a resume continues into the same journey and finishes it', { steps: j2.steps.length, stoppedBy: s2.stoppedBy });
  const keys = j2.steps.map(s => s.stimulus.args.join('\u0000'));
  assert(new Set(keys).size === keys.length, 'a resumed run does not repeat what the first run already tried');
  assert(JSON.parse(fs.readFileSync(path.join(C.corpusDir('cov-greeter'), 'meta.json'), 'utf8')).createdAt === created, 'a resume keeps the original recording metadata');
  const spec2 = C.synthesize(j2, undefined, s2);
  assert(spec2.coverage.ratio === 1 && !spec2.unknowns.some(u => /unvisited/.test(u)), 'a finished exploration reports full coverage of what it found', spec2.coverage);
  const j3 = await C.explore('cov-greeter', cli('target.mjs'), { maxSteps: 3, overwrite: true });
  assert(j3.steps.length === 3, '--force starts over');
}

section('model-guided exploration');
{
  const options = ['--help', '--version', 'greet --help'];
  const g1 = C.createGuide(async () => 'Sure! ```json\n["--version", "rm -rf /", "--help"]\n```');
  assert(JSON.stringify(await g1({ kind: 'cli', state: 's', options, history: [] })) === JSON.stringify(['--version', '--help']), 'picks are read out of prose and fences, and an option that was not on offer is dropped');
  assert(C.parsePicks('no array here', options) === undefined && C.parsePicks('["nope"]', options) === undefined, 'a reply with nothing usable leaves the default order');
  let asked = 0;
  const g2 = C.createGuide(async () => { asked++; return '["--version"]'; }, { maxCalls: 2 });
  await g2({ kind: 'cli', state: 'a', options, history: [] }); await g2({ kind: 'cli', state: 'a', options, history: [] }); await g2({ kind: 'cli', state: 'b', options, history: [] }); await g2({ kind: 'cli', state: 'c', options, history: [] });
  assert(asked === 2 && g2.calls() === 2, 'the same view is not asked twice, and the number of calls is capped', { asked });
  const g3 = C.createGuide(async () => { throw new Error('provider down'); });
  assert(await g3({ kind: 'cli', state: 's', options, history: [] }) === undefined, 'a guide that fails leaves the default order');

  const j = await C.explore('guided-greeter', cli('target.mjs'), { maxSteps: 3, guide: C.createGuide(async () => '["--version"]') });
  assert(j.steps[0].stimulus.args.join(' ') === '--version', 'the guide changes what is tried first', j.steps.map(s => s.stimulus.args.join(' ')));
  const j0 = await C.explore('unguided-greeter', cli('target.mjs'), { maxSteps: 3 });
  assert(j0.steps[0].stimulus.args.join(' ') === '--help', 'without a guide the default order stands', j0.steps.map(s => s.stimulus.args.join(' ')));
  const j4 = await C.explore('hallucinating-greeter', cli('target.mjs'), { maxSteps: 3, guide: C.createGuide(async () => '["delete everything"]') });
  assert(j4.steps.every(s => !/delete/.test(s.stimulus.args.join(' '))), 'a hallucinated option never becomes a stimulus');

  let calls = 0;
  const provider = { id: 'mock', displayName: 'Mock', async *chat() { calls++; yield { type: 'text', content: '["--version"]' }; yield { type: 'usage', inputTokens: 100, outputTokens: 10 }; yield { type: 'finish', reason: 'stop' }; } };
  const free = C.createModelCompleter({ settings: {}, model: 'mock', budgetUsd: 0, provider });
  assert((await free('s', 'u')) === '' && calls === 0, 'a spent budget stops the guide before it calls the model');
  const paid = C.createModelCompleter({ settings: {}, model: 'mock', budgetUsd: 5, provider });
  assert((await paid('s', 'u')) === '["--version"]' && calls === 1, 'within budget the completer calls the provider');
}

section('clone-side exploration: the spec diff');
{
  fs.writeFileSync(path.join(cliDir, 'lacking.mjs'), cliSource('clone').replace("  count                  count the lines on stdin\n", '').replace("  --shout                upper-case the greeting\n", '  --loud                 upper-case the greeting\n'));
  const jt = await C.explore('diff-target', cli('target.mjs'), { maxSteps: 40 });
  const st = C.synthesize(jt, undefined, C.readExplorerState('diff-target'));
  const jc = await C.explore('diff-same', cli('clone.mjs'), { maxSteps: 40 });
  const same = C.diffSpecs(st, C.synthesize(jc, undefined, C.readExplorerState('diff-same')));
  assert(same.onlyInTarget.length === 0 && same.onlyInClone.length === 0 && same.changed.length === 0 && same.same > 3, 'an identical clone has no difference in what it exposes', same);
  const jl = await C.explore('diff-lacking', cli('lacking.mjs'), { maxSteps: 40 });
  const bad = C.diffSpecs(st, C.synthesize(jl, undefined, C.readExplorerState('diff-lacking')));
  const text = C.renderSpecDiff(bad);
  assert(bad.onlyInTarget.some(x => /--shout|command count/.test(x)) || bad.changed.some(x => /--shout/.test(x)), 'a flag or command the target has and the clone lacks is found without any recorded journey touching it', text);
  assert(bad.changed.some(x => /--loud/.test(x)) || bad.onlyInClone.length > 0, 'something extra the clone invented is found too', text);
  const w = (v) => new Promise(r => { const s = apiServer(v); s.listen(0, '127.0.0.1', () => r(s)); });
  const [a, b] = await Promise.all([w('target'), w('wrong')]);
  const ja = await C.explore('diff-api-target', { kind: 'api', baseUrl: `http://127.0.0.1:${a.address().port}` }, { maxSteps: 40 });
  const jb = await C.explore('diff-api-wrong', { kind: 'api', baseUrl: `http://127.0.0.1:${b.address().port}` }, { maxSteps: 40 });
  const apiDiff = C.diffSpecs(C.synthesize(ja), C.synthesize(jb));
  assert(apiDiff.changed.some(x => /different shape/.test(x)), 'an API clone returning a different response shape is found by spec diff', apiDiff);
  a.close(); b.close();
}

console.log(`\ncleanroom: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
