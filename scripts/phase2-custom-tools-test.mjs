/**
 * Phase 2 of the agents/skills/tools design (docs/engineering/design/
 * agents-skills-tools.md §10): custom tools — a typed JSON wrapper around one
 * command (argv) or one HTTP call.
 *
 * What each block proves, against the acceptance list:
 *   - definitions are validated, with messages that name the fix;
 *   - argument injection (`; rm`, `$(…)`, a leading `--flag`, `..` in a
 *     pattern-less string) is refused before anything spawns, and values an
 *     author did allow stay exactly one argv element each — through a real
 *     `.exe` on Windows, through a `.cmd` shim (quoted, or refused when cmd
 *     syntax would be re-parsed), and with no shell at all on POSIX;
 *   - effect classes route approvals: destructive asks at L3 with its preview
 *     and no "always", a "no" (or nobody to ask) means it never runs, plan
 *     mode refuses non-read tools, external asks once (every time once the
 *     session is tainted), ask mode asks once rather than twice;
 *   - secrets: `{{secret:…}}` and `{{secret-file:…}}` resolve in trusted code;
 *     a canary never reaches the log, the stream or the result, and the temp
 *     file is gone after success, failure, timeout, a spawn error and a
 *     secret that failed half-way;
 *   - a project's tools are blocked until the project is trusted, and again
 *     when they change;
 *   - `custom:<name>` allow-lists bound agents;
 *   - drafts are not callable until a person enables them (not the model,
 *     not the API token), and an edit un-enables;
 *   - with three packs installed the depth-0 request stays within 1% and
 *     carries no custom schema until `LoadTools` names a pack.
 *
 * Offline and free; nothing touches ~/.aico.
 */

// A store of this process's own — nothing below may touch ~/.aico. Must stay first.
import { testHome } from './lib/test-home.mjs';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

const T = await import('../dist-test/test-exports.js');

let passed = 0;
let failed = 0;
const failures = [];
function assert(cond, name) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name); console.log(`  ✗ ${name}`); }
}
async function block(title, fn) {
  console.log(`\n══ ${title} ══`);
  try { await fn(); } catch (err) { assert(false, `${title}: threw ${err?.stack ?? err}`); }
}

fs.writeFileSync(path.join(process.env.AICO_HOME, 'settings.json'), '{}');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aico phase2 '));   // a space on purpose: paths with spaces
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });
const NODE = process.execPath;
const script = (name, body) => { const f = path.join(tmp, name); fs.writeFileSync(f, body); return f; };
const ARGV_JS = script('argv.cjs', 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
const TOUCH_JS = script('touch.cjs', 'require("fs").writeFileSync(process.argv[2], "ran")');
const SECRET_JS = script('secret.cjs', [
  'const fs = require("fs");',
  'const file = process.env.FILE;',
  'console.log("TOKEN=" + process.env.TOKEN);',
  'if (file) { console.log("PATHIS=" + file); console.log("FILE=" + fs.readFileSync(file, "utf8")); }',
  'const mode = process.argv[2];',
  'if (mode === "fail") { console.error("boom " + process.env.TOKEN); process.exit(3); }',
  'if (mode === "sleep") setTimeout(() => {}, 60000);',
].join('\n'));
const PLAN_JS = script('plan.cjs', 'console.log("PLAN: would change release " + process.argv[2])');

const userTools = path.join(process.env.AICO_HOME, 'tools');
function writeTool(root, pack, def) {
  const f = path.join(root, pack, `${def.name}.tool.json`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(def, null, 2));
  return f;
}
async function enable(name, cwd = tmp) {
  const t = (await T.loadCustomTools(cwd)).find(x => x.name === name);
  T.setToolEnabled(t, true);
}
const schema = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });

// ── a scripted model ────────────────────────────────────────────────────
function mock(steps) {
  let i = 0;
  return {
    id: 'mock', displayName: 'Mock', toolSchemas: [], toolDefs: [],
    async *chat(opts) {
      this.toolSchemas.push((opts.tools ?? []).map(t => t.name));
      this.toolDefs.push(opts.tools ?? []);
      const step = steps[Math.min(i++, steps.length - 1)];
      for (const ev of step) yield ev;
    },
  };
}
const calls = (...list) => [
  ...list.map(([name, input], i) => [{ type: 'tool_call', id: `c${i}-${name}`, name, input }, { type: 'finish', reason: 'tool_calls' }]),
  [{ type: 'text', content: 'done' }, { type: 'finish', reason: 'stop' }],
];
const SETTINGS = { completionGate: { enabled: false }, cron: { enabled: false }, repeatGuard: { enabled: false } };
let runs = 0;
async function turn(steps, extra = {}) {
  const session = extra.session ?? new T.Session({ id: `phase2-${++runs}`, cwd: extra.cwd ?? tmp, startedAt: Date.now() });
  const provider = mock(steps);
  const stream = [];
  await T.runAgent({
    task: 'go', model: 'mock-model', showPlan: false, autoApprove: true, verbose: false, silent: true,
    conversationHistory: [], sessionId: session.header.id, session, provider, settings: SETTINGS, cwd: tmp,
    onToolCall: (...a) => stream.push(JSON.stringify(a)),
    onToolDone: (...a) => stream.push(JSON.stringify(a)),
    onChunk: (t) => stream.push(String(t)),
    ...extra,
  });
  const results = session.events.filter(e => e.type === 'tool/result').map(e => JSON.stringify(e.data));
  return { session, provider, offered: provider.toolSchemas[0] ?? [], results, stream };
}

// ═══════════════════════════════════════════════════════════════════════
await block('Deferred packs keep the depth-0 budget flat', async () => {
  const base = await turn([[{ type: 'text', content: 'hi' }, { type: 'finish', reason: 'stop' }]]);
  const tokens = (defs) => T.estimateTokens(JSON.stringify(defs));
  const before = tokens(base.provider.toolDefs[0]);
  for (const pack of ['alpha', 'beta', 'gamma']) {
    for (const n of [1, 2, 3]) {
      writeTool(userTools, pack, {
        name: `${pack}_tool${n}`, description: `Reads ${pack} thing number ${n}; a long description that would cost tokens if it were always sent to the model on every request.`,
        input_schema: schema({ id: { type: 'string', pattern: '^[a-z0-9-]{1,40}$', description: 'which one' } }),
        run: { argv: [NODE, ARGV_JS, '{id}'] }, effect: 'read',
      });
      await enable(`${pack}_tool${n}`);
    }
  }
  const lean = await turn([[{ type: 'text', content: 'hi' }, { type: 'finish', reason: 'stop' }]]);
  const after = tokens(lean.provider.toolDefs[0]);
  assert(!lean.offered.some(n => /_tool\d$/.test(n)), 'with three packs installed, no custom schema is sent until loaded');
  const loader = lean.provider.toolDefs[0].find(d => d.name === 'LoadTools');
  assert(/- tools:alpha: custom tools — alpha_tool1, alpha_tool2, alpha_tool3/.test(loader.description), 'LoadTools names each pack and its tools in one line');
  assert(after - before <= 143, `the depth-0 request grows by ${after - before} tokens (≤ 1% of the 14,282 baseline)`);
  const loaded = await turn(calls(['LoadTools', { groups: ['tools:beta'] }]));
  assert(loaded.provider.toolSchemas[1].includes('beta_tool2') && !loaded.provider.toolSchemas[1].includes('alpha_tool1'), 'LoadTools offers that pack from the next step, and only that pack');
  const again = await turn([[{ type: 'text', content: 'hi' }, { type: 'finish', reason: 'stop' }]], { session: loaded.session });
  assert(again.offered.includes('beta_tool1'), 'a loaded pack stays loaded for the session (read from the log)');
  const direct = await turn(calls(['gamma_tool1', { id: 'x1' }]));
  assert(direct.results.some(r => /x1/.test(r) && !/error/i.test(r)), 'calling a deferred custom tool by name is served');
  assert(T.groupsLoadedBy('LoadTools', { groups: ['tools:beta', 'tools:../x'] }).join() === 'tools:beta', 'only well-formed pack ids are read from a LoadTools call');
  for (const pack of ['alpha', 'beta', 'gamma']) fs.rmSync(path.join(userTools, pack), { recursive: true, force: true });
});

await block('Definitions are validated, with the fix named', async () => {
  const ok = {
    name: 'k8s_get', description: 'Get pods in a namespace.',
    input_schema: schema({ namespace: { type: 'string', pattern: '^[a-z0-9-]{1,63}$' } }),
    run: { argv: ['kubectl', 'get', 'pods', '-n', '{namespace}'] }, effect: 'read',
  };
  const reserved = new Set(['Bash', 'Read']);
  assert(T.validateDefinition(ok, { reserved }).errors.length === 0, 'a well-formed tool is valid');
  const bad = (patch, re, label) => {
    const r = T.validateDefinition({ ...ok, ...patch }, { reserved });
    assert(r.errors.some(e => re.test(e)), `${label} (${r.errors.join(' | ').slice(0, 140)})`);
  };
  bad({ input_schema: { ...ok.input_schema, additionalProperties: true } }, /additionalProperties must be false/, 'additionalProperties must be false');
  bad({ run: { argv: ['kubectl', '--namespace={namespace}'] } }, /whole argv element/, 'a placeholder inside a longer element is refused');
  bad({ run: { argv: ['{namespace}', 'x'] } }, /argv\[0\]/, 'the program cannot be a placeholder');
  bad({ run: { argv: ['curl', '{{secret:tok}}'] } }, /never go in arguments/, 'a secret in argv is refused');
  bad({ run: { argv: ['x'], env: { T: 'Bearer {{secret:tok}}' } } }, /whole value/, 'a secret must be a whole env value');
  bad({ effect: 'destructive', approval: 'none' }, /cannot relax a destructive/, 'approval cannot relax destructive');
  bad({ effect: 'exec', approval: 'none' }, /relax only an external/, 'approval none only relaxes external');
  bad({ name: 'Bash' }, /lower-case/, 'a built-in name is refused (shape)');
  assert(T.validateDefinition({ ...ok, name: 'bash_x' }, { reserved: new Set(['bash_x']) }).errors.some(e => /taken/.test(e)), 'a taken name is refused');
  bad({ input_schema: schema({ namespace: { type: 'string', pattern: '[a-z]+' } }) }, /anchor/, 'an unanchored pattern is refused');
  bad({ input_schema: schema({ list: { type: 'array' } }) }, /not supported/, 'nested types point at MCP');
  bad({ http: { method: 'GET', url: 'https://x.test/{{secret:t}}' } }, /not both|never go in the URL/, 'run and http together, or a secret in a URL, is refused');
  bad({ run: undefined, http: { method: 'GET', url: 'https://{namespace}.example.com/' } }, /host is fixed/, 'the HTTP host cannot be a placeholder');
  bad({ effect: 'sometimes' }, /effect must be one of/, 'effect is required and checked');
});

await block('Arguments: injection is refused before spawn', async () => {
  const s = schema({ path: { type: 'string' }, ns: { type: 'string', pattern: '^[a-z-]+$' }, v: { type: 'string', pattern: '^-v+$', allowFlagLike: true } }, []);
  const refused = (args, re, label) => {
    const p = T.validateArgs(s, args);
    assert(p.some(m => re.test(m)), `${label} (${p.join(' ').slice(0, 100)})`);
  };
  refused({ path: 'a; rm -rf ~' }, /shell syntax/, '"; rm -rf ~" in free text');
  refused({ path: '$(whoami)' }, /shell syntax/, '"$(…)" in free text');
  refused({ path: '`id`' }, /shell syntax/, 'backticks in free text');
  refused({ path: '--kubeconfig=/evil' }, /begins with "-"/, 'a leading --flag');
  refused({ ns: '-n' }, /begins with "-"/, 'a leading flag even where a pattern would allow it');
  refused({ path: '../../etc/passwd' }, /"\.\." path segment/, 'path traversal in a pattern-less string');
  refused({ path: 'C:\\x\\..\\..\\Windows' }, /"\.\." path segment/, 'Windows-style traversal');
  refused({ path: 'line1\nline2' }, /newline/, 'a newline');
  refused({ ns: 'Bad_NS' }, /does not match/, 'a pattern miss');
  refused({ extra: 'x' }, /not a parameter/, 'an undeclared field');
  assert(T.validateArgs(s, { path: 'src/app.ts', ns: 'prod', v: '-vv' }).length === 0, 'ordinary values pass, and allowFlagLike admits -vv');

  // A refused call never starts the process.
  const marker = path.join(tmp, 'touched-by-injection');
  writeTool(userTools, 'inj', { name: 'inj_touch', description: 'Touch a file.', input_schema: schema({ p: { type: 'string' } }), run: { argv: [NODE, TOUCH_JS, '{p}'] }, effect: 'read' });
  await enable('inj_touch');
  const r = await turn(calls(['inj_touch', { p: `${marker}; echo pwned` }]));
  assert(!fs.existsSync(marker) && !fs.existsSync(`${marker}; echo pwned`), 'a refused call never spawned');
  assert(r.results.some(x => /refused before anything started/.test(x)), 'and the model is told why');
});

await block('Argv: an allowed hostile value stays one argv item', async () => {
  const hostile = ['a; rm -rf / & echo pwned', '$(whoami) "dq" \'sq\' \\back\\slash\\', '%PATH% ^caret | pipe > out < in', 'trailing\\', 'two  spaces', ''];
  const def = {
    name: 'echo_argv', description: 'Echo argv.',
    input_schema: schema({ a: { type: 'string', pattern: '^[^\\r\\n]*$', allowFlagLike: true }, b: { type: 'string', pattern: '^[^\\r\\n]*$' } }, ['a']),
    run: { argv: [NODE, ARGV_JS, '{a}', 'literal {x} stays', '{b}'] }, effect: 'read',
  };
  assert(T.validateDefinition(def).errors.length === 0, 'definition valid');
  for (const value of hostile) {
    const out = await T.runCustomTool(def, { a: value, b: value }, { cwd: tmp });
    let got;
    try { got = JSON.parse(out.stdout); } catch { got = out; }
    assert(JSON.stringify(got) === JSON.stringify([value, 'literal {x} stays', value]), `${JSON.stringify(value)} arrives as exactly one element (${process.platform})`);
  }
  const optional = await T.runCustomTool(def, { a: 'x' }, { cwd: tmp });
  assert(optional.stdout === '["x","literal {x} stays"]', 'an absent optional field drops its element; a literal with braces is kept');
  const posix = T.spawnPlan('prog', ['a; b', '$(c)'], 'linux');
  assert(posix.file === 'prog' && posix.args.join('|') === 'a; b|$(c)' && !posix.windowsVerbatimArguments, 'POSIX: no shell, arguments handed over untouched');

  if (process.platform === 'win32') {
    const shim = path.join(tmp, 'shim dir', 'echo-shim.cmd');
    fs.mkdirSync(path.dirname(shim), { recursive: true });
    fs.writeFileSync(shim, `@echo off\r\n"${NODE}" "${ARGV_JS}" %*\r\n`);
    const viaShim = { ...def, name: 'shim_echo', run: { argv: [shim, '{a}'] } };
    const okOut = await T.runCustomTool(viaShim, { a: 'hello world, a=b' }, { cwd: tmp });
    assert(okOut.stdout === '["hello world, a=b"]', `a .cmd shim in a path with spaces gets a spaced value as one argument (${JSON.stringify(okOut).slice(0, 120)})`);
    const pwned = path.join(tmp, 'pwned-by-cmd');
    const bad = await T.runCustomTool(viaShim, { a: `x & echo hacked > "${pwned}"` }, { cwd: tmp });
    assert(/batch file/.test(bad.error ?? '') && !fs.existsSync(pwned), 'cmd syntax for a .cmd shim is refused before cmd.exe starts');
    const pct = await T.runCustomTool(viaShim, { a: '%USERNAME%' }, { cwd: tmp });
    assert(/batch file/.test(pct.error ?? ''), '%VAR% for a .cmd shim is refused (cmd would expand it)');
    assert(!T.resolveWindowsProgram(NODE).shim, 'node.exe is spawned directly, not through cmd');
  } else {
    assert(true, 'Windows .cmd shim cases run on Windows only');
  }
});

await block('Effect classes route approvals', async () => {
  const d = (effect, s, approval) => T.approvalDecision('t', effect, approval, s);
  assert(d('read', { autoApprove: true }).kind === 'allow', 'L3 read: runs');
  assert(d('exec', { autoApprove: true }).kind === 'allow' && d('write', { autoApprove: true }).kind === 'allow', 'L3 write/exec: run');
  assert(d('external', { autoApprove: true }).mode === 'first-use' && d('external', { autoApprove: true, approvedBefore: true }).kind === 'allow', 'L3 external: first use asked, then not');
  assert(d('external', { autoApprove: true, approvedBefore: true, tainted: true }).mode === 'every-use', 'L3 external in a tainted session: every use');
  assert(d('external', { autoApprove: true }, 'none').kind === 'allow', 'an author can relax external to none');
  assert(d('destructive', { autoApprove: true }).mode === 'every-use' && d('destructive', { autoApprove: true, approvedBefore: true }).mode === 'every-use', 'L3 destructive: every use, always');
  assert(d('exec', { autoApprove: false }).mode === 'standard' && d('read', { autoApprove: false }).kind === 'allow', 'L1/L2: changes asked, reads not');
  assert(d('write', { planMode: true, autoApprove: true }).kind === 'deny' && d('read', { planMode: true, autoApprove: true }).kind === 'allow', 'L0 plan: only reads');
  assert(d('exec', { autoApprove: true }, 'every-use').mode === 'every-use', 'an author can tighten anything');
  assert(T.taints('WebFetch') && T.taints('mcp__x__y') && !T.taints('Read'), 'web and MCP results taint');

  const marker = path.join(tmp, 'applied');
  writeTool(userTools, 'demo', { name: 'demo_plan', description: 'Show what would change.', input_schema: schema({ release: { type: 'string', pattern: '^[a-z]+$' } }), run: { argv: [NODE, PLAN_JS, '{release}'] }, effect: 'read' });
  writeTool(userTools, 'demo', {
    name: 'demo_apply', description: 'Apply the change. Irreversible.', input_schema: schema({ release: { type: 'string', pattern: '^[a-z]+$' } }),
    run: { argv: [NODE, TOUCH_JS, marker] }, effect: 'destructive', preview: { tool: 'demo_plan', args: 'same' },
  });
  writeTool(userTools, 'demo', { name: 'demo_post', description: 'Post a comment somewhere.', input_schema: schema({ release: { type: 'string', pattern: '^[a-z]+$' } }), run: { argv: [NODE, ARGV_JS, 'posted'] }, effect: 'external' });
  writeTool(userTools, 'demo', { name: 'demo_exec', description: 'Run something local.', input_schema: schema({}), run: { argv: [NODE, ARGV_JS, 'ran'] }, effect: 'exec' });
  for (const n of ['demo_plan', 'demo_apply', 'demo_post', 'demo_exec']) await enable(n);

  const asked = [];
  const no = await turn(calls(['demo_apply', { release: 'web' }]), { onApprovalRequired: async (tool, detail) => { asked.push({ tool, detail }); return false; } });
  assert(asked.length === 1 && asked[0].tool === 'demo_apply', 'destructive at L3 (auto) asks a person');
  assert(/PLAN: would change release web/.test(asked[0].detail) && /Preview \(demo_plan\)/.test(asked[0].detail), 'the card shows the preview tool\'s output');
  assert(asked[0].detail.includes(marker.replace(/\\/g, '\\\\')) || asked[0].detail.includes(marker) || /touch\.cjs/.test(asked[0].detail), 'and the exact argv');
  assert(/no "always allow"/.test(asked[0].detail), 'and says there is no always-allow');
  assert(!fs.existsSync(marker) && no.results.some(r => /did not approve/.test(r)), 'denied → it never ran, and the model is told not to work around it');

  const yes = await turn(calls(['demo_apply', { release: 'web' }], ['demo_apply', { release: 'web' }]), { onApprovalRequired: async () => true });
  assert(fs.existsSync(marker), 'approved → it ran');
  fs.rmSync(marker, { force: true });
  assert(yes.results.length === 2, 'and a second call in the same session asked again (two results, both approved)');

  const nobody = await turn(calls(['demo_apply', { release: 'web' }]), { headless: true });
  assert(!fs.existsSync(marker) && nobody.results.some(r => /nobody is available/.test(r)), 'headless (nobody to ask) → refused, never run');

  const plan = await turn(calls(['demo_apply', { release: 'web' }], ['demo_exec', {}]), { planMode: true, settings: { ...SETTINGS, deferTools: false } });
  assert(!plan.offered.includes('demo_apply') && !plan.offered.includes('demo_exec') && plan.offered.includes('demo_plan'), 'plan mode offers only read custom tools');
  assert(!fs.existsSync(marker) && plan.results.every(r => /Unknown tool|not available/i.test(r)), 'and a non-read one named anyway does not run');

  const ext = [];
  const sessionExt = new T.Session({ id: 'phase2-ext', cwd: tmp, startedAt: Date.now() });
  await turn(calls(['demo_post', { release: 'a' }], ['demo_post', { release: 'b' }]), { session: sessionExt, onApprovalRequired: async (t) => { ext.push(t); return true; } });
  assert(ext.length === 1, 'external at L3: asked on first use only');
  const tainted = new T.Session({ id: 'phase2-taint', cwd: tmp, startedAt: Date.now() });
  tainted.append('tool/call', { turn: 1, step: 1, callId: 'w', name: 'WebFetch', arguments: '{"url":"https://example.com"}' });
  const ext2 = [];
  await turn(calls(['demo_post', { release: 'a' }], ['demo_post', { release: 'b' }]), { session: tainted, onApprovalRequired: async (t) => { ext2.push(t); return true; } });
  assert(ext2.length === 2, 'external after web content in the session: asked every time');

  const perm = [];
  await turn(calls(['demo_exec', {}]), { autoApprove: false, onPermissionRequest: async (t) => { perm.push(t); return true; } });
  assert(perm.length === 1 && perm[0] === 'demo_exec', 'ask mode: an exec tool asks once (not once per stage)');
  const permNo = [];
  const r = await turn(calls(['demo_exec', {}]), { autoApprove: false, onPermissionRequest: async (t) => { permNo.push(t); return false; } });
  assert(r.results.some(x => /did not approve/.test(x)) && !r.results.some(x => /"ran"/.test(x)), 'ask mode: denied → not run');
});

await block('Secrets: broker-resolved, redacted, temp files always removed', async () => {
  const vault = T.configureVault({ dir: path.join(testHome, 'vault'), keyProvider: T.memoryKeyProvider() });
  const CANARY = 'Canary-Fake-Tok-5566778899aabb'; // standards-allow: secret (test canary)
  await vault.create({ name: 'canary-tok', kind: 'api-token', secret: { token: CANARY }, createdBy: 'user', policy: { approval: 'auto' } });
  const def = (name, extra = {}) => ({
    name, description: 'Use a token.', input_schema: schema({ mode: { type: 'string', enum: ['ok', 'fail', 'sleep'] } }, []),
    run: { argv: [NODE, SECRET_JS, '{mode}'], env: { TOKEN: '{{secret:canary-tok}}', FILE: '{{secret-file:canary-tok}}' }, ...extra }, effect: 'read',
  });
  writeTool(userTools, 'sec', def('sec_use'));
  await enable('sec_use');
  const leftovers = () => { try { return fs.readdirSync(T.secretFileRoot()); } catch { return []; } };

  const r = await turn(calls(['sec_use', {}]));
  const log = JSON.stringify(r.session.events);
  assert(!log.includes(CANARY), 'the canary is not in the session log');
  assert(!r.stream.join('\n').includes(CANARY), 'nor in anything streamed to a client');
  assert(r.results.some(x => /TOKEN=\[secret:canary-tok\]/.test(x)) && r.results.some(x => /FILE=\[secret:canary-tok\]/.test(x)), 'the result shows the redacted name where the value was printed');
  assert(r.results.some(x => /PATHIS=/.test(x)) && leftovers().length === 0, 'the temp file existed for the call and is gone after it');

  const out1 = await T.runCustomTool(def('sec_use'), { mode: 'fail' }, { cwd: tmp });
  const p1 = /PATHIS=(.*)/.exec(out1.stdout ?? '')?.[1]?.trim();
  assert(out1.exitCode === 3 && /exited with code 3/.test(out1.error) && p1 && !fs.existsSync(p1), 'non-zero exit: an actionable error, and the file is gone');
  assert(!JSON.stringify(T.sinkRedact(out1)).includes(CANARY), 'and the error is redacted by the sink');

  const sleeper = { ...def('sec_sleep', { timeoutSec: 1 }) };
  const out2 = await T.runCustomTool(sleeper, { mode: 'sleep' }, { cwd: tmp });
  const p2 = /PATHIS=(.*)/.exec(out2.stdout ?? '')?.[1]?.trim();
  assert(/timed out after 1s/.test(out2.error) && p2 && !fs.existsSync(p2), 'timeout: stopped, and the file is gone');

  const missing = { ...def('sec_missing'), run: { argv: [path.join(tmp, 'no-such-program')], env: { FILE: '{{secret-file:canary-tok}}' } } };
  const out3 = await T.runCustomTool(missing, {}, { cwd: tmp });
  assert(/could not start/.test(out3.error) && leftovers().length === 0, 'spawn error: reported, and the file is gone');

  const halfway = { ...def('sec_half'), run: { argv: [NODE, SECRET_JS], env: { FILE: '{{secret-file:canary-tok}}', OTHER: '{{secret:not-in-vault}}' } } };
  const out4 = await T.runCustomTool(halfway, {}, { cwd: tmp });
  assert(/did not run/.test(out4.error) && /not-in-vault/.test(out4.error) && leftovers().length === 0, 'a second secret that fails after the first file was written: nothing runs, the file is gone');

  const ac = new AbortController();
  const p5 = T.runCustomTool(sleeper, { mode: 'sleep' }, { cwd: tmp, signal: ac.signal });
  setTimeout(() => ac.abort(), 300);
  const out5 = await p5;
  assert(/cancelled|timed out/.test(out5.error ?? '') && leftovers().length === 0, 'cancelled mid-run: stopped, and the file is gone');

  // HTTP: the header secret is resolved for the request's origin by the ops client.
  let seen = '';
  const server = http.createServer((req, res) => { seen = `${req.url} ${req.headers['x-api-key']}`; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ echoed: req.headers['x-api-key'], path: req.url })); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const API = 'Api-Canary-Fake-0099887766'; // standards-allow: secret (test canary)
  await vault.create({ name: 'api-canary', kind: 'api-token', secret: { token: API }, url: origin, createdBy: 'user', policy: { approval: 'auto' } });
  const httpDef = {
    name: 'api_item', description: 'Get an item.', input_schema: schema({ id: { type: 'string' } }),
    http: { method: 'GET', url: `${origin}/items/{id}`, headers: { 'X-Api-Key': '{{secret:api-canary}}' } }, effect: 'read',
  };
  assert(T.validateDefinition(httpDef).errors.length === 0, 'an HTTP tool is valid');
  const hr = T.sinkRedact(await T.runCustomTool(httpDef, { id: 'a b/c' }, { cwd: tmp }));
  server.close();
  assert(seen === `/items/a%20b%2Fc ${API}`, `the server got the encoded path and the secret header (${seen.replace(API, '<value>')})`);
  assert(!JSON.stringify(hr).includes(API), 'the value never comes back in the result');
});

await block('Project tools wait for project trust', async () => {
  const proj = fs.mkdtempSync(path.join(tmp, 'proj-'));
  const projTools = path.join(proj, '.aico', 'tools');
  writeTool(projTools, 'repo', { name: 'repo_hello', description: 'Say hello from the project.', input_schema: schema({}), run: { argv: [NODE, ARGV_JS, 'hello'] }, effect: 'read' });
  let status = await T.projectTrustStatus(proj);
  assert(status.state === 'untrusted' && /custom tool "repo_hello" \(read\)/.test(status.summary), 'a project shipping a tool is untrusted, and the prompt shows the tool and its command');
  let tools = await T.loadCustomTools(proj);
  assert(tools.find(t => t.name === 'repo_hello')?.status === 'untrusted', 'its tool is not callable');
  const before = await turn(calls(['repo_hello', {}]), { cwd: proj, settings: { ...SETTINGS, deferTools: false } });
  assert(!before.offered.includes('repo_hello') && !before.results.some(r => /hello/.test(r) && !/Unknown/.test(r)), 'not offered and not run before trust');
  await T.approveProjectTrust(status.root, status.hash);
  tools = await T.loadCustomTools(proj);
  assert(tools.find(t => t.name === 'repo_hello')?.status === 'enabled', 'trusted → enabled');
  const after = await turn(calls(['repo_hello', {}]), { cwd: proj, settings: { ...SETTINGS, deferTools: false } });
  assert(after.offered.includes('repo_hello') && after.results.some(r => /hello/.test(r) && !/error|Unknown/i.test(r)), 'and it runs');
  writeTool(projTools, 'repo', { name: 'repo_hello', description: 'Say hello, changed.', input_schema: schema({}), run: { argv: [NODE, ARGV_JS, 'changed'] }, effect: 'read' });
  status = await T.projectTrustStatus(proj);
  assert(status.state === 'untrusted' && (await T.loadCustomTools(proj)).find(t => t.name === 'repo_hello').status === 'untrusted', 'changing the tool asks again');
  // Run from the folder that holds the user's store (the home directory): its
  // `.aico/tools` is the user store, not a project's — found live.
  const homeParent = path.dirname(process.env.AICO_HOME);
  assert(!(await T.loadCustomTools(homeParent)).some(t => t.scope === 'project') && (await T.projectTrustStatus(homeParent)).state === 'none',
    'in the home directory the user\'s own tools are not read again as project tools, nor put behind project trust');
  const none = fs.mkdtempSync(path.join(tmp, 'none-'));
  assert((await T.projectTrustStatus(none)).state === 'none', 'a project with no tools and no gated settings needs no trust (hash unchanged)');
});

await block('Scope: custom:<name> allow-lists bound agents', async () => {
  writeTool(userTools, 'scope', { name: 'scope_a', description: 'A.', input_schema: schema({}), run: { argv: [NODE, ARGV_JS, 'AAA-ran'] }, effect: 'read' });
  writeTool(userTools, 'scope', { name: 'scope_b', description: 'B.', input_schema: schema({}), run: { argv: [NODE, ARGV_JS, 'BBB-ran'] }, effect: 'read' });
  await enable('scope_a'); await enable('scope_b');
  const onlyRead = await turn(calls(['scope_a', {}]), { agentSpecTools: ['Read'] });
  assert(!onlyRead.offered.some(n => n.startsWith('scope_')), 'an agent with tools:[Read] is offered no custom tool');
  assert(onlyRead.results.some(r => /Unknown tool/.test(r)), 'and one named anyway does not run');
  const allowed = await turn(calls(['scope_a', {}], ['scope_b', {}]), { agentSpecTools: ['Read', 'custom:scope_a'] });
  assert(allowed.offered.includes('scope_a') && !allowed.offered.includes('scope_b'), 'custom:scope_a admits exactly that tool, offered directly (a hand-picked list is not deferred)');
  assert(allowed.results.some(r => /AAA-ran/.test(r)) && !allowed.results.some(r => /BBB-ran/.test(r)) && allowed.results.some(r => /Unknown tool/.test(r)), 'it runs; the other does not');
  const layer = T.layerFor('x', ['custom:scope_a'], []);
  assert(T.scopeAllows({ layers: [layer], delegate: true }, 'scope_a') && !T.scopeAllows({ layers: [layer], delegate: true }, 'scope_b'), 'the resolver reads custom: entries');
  const disabled = await turn(calls(['scope_a', {}]), { settings: { ...SETTINGS, deferTools: false, disabledTools: ['custom:scope_a'] } });
  assert(!disabled.offered.includes('scope_a') && disabled.offered.includes('scope_b'), 'disabledTools takes custom: entries too');
});

await block('Drafts are not callable until a person enables them', async () => {
  const created = await T.executeToolManage({
    action: 'create', pack: 'mine',
    definition: { name: 'mine_count', description: 'Count lines.', input_schema: schema({}), run: { argv: [NODE, ARGV_JS, 'counted'] }, effect: 'read' },
  }, { cwd: tmp });
  assert(/^Draft written/.test(created) && /not callable until a person enables it/.test(created), 'ToolManage create writes a draft');
  const draft = await turn(calls(['mine_count', {}]), { settings: { ...SETTINGS, deferTools: false } });
  assert(!draft.offered.includes('mine_count') && draft.results.some(r => /Unknown tool/.test(r)), 'a draft is neither offered nor callable');
  assert(/^Not enabled/.test(await T.executeToolManage({ action: 'enable', name: 'mine_count' }, { cwd: tmp })), 'the model cannot enable it');
  const byToken = await T.handleSystemRoute('manage', 'POST', { registry: 'tools', action: 'enable', name: 'mine_count' });
  assert(byToken.body.ok === false && /Not enabled/.test(byToken.body.result), 'the API token alone cannot enable it');
  const dry = await T.executeToolManage({ action: 'test', name: 'mine_count', args: {} }, { cwd: tmp });
  assert(/Would run/.test(dry) && /Dry run only/.test(dry) && !/Result:/.test(dry), 'the model\'s test is a dry run');
  const person = async () => ({ ok: true });
  const byPerson = await T.handleSystemRoute('manage', 'POST', { registry: 'tools', action: 'enable', name: 'mine_count' }, undefined, person);
  assert(byPerson.body.ok === true && /Enabled/.test(byPerson.body.result), 'a person enables it');
  const tested = await T.handleSystemRoute('manage', 'POST', { registry: 'tools', action: 'test', name: 'mine_count', args: {} }, undefined, person);
  assert(/Result:/.test(tested.body.result) && /counted/.test(tested.body.result), 'a person\'s test runs a read tool');
  const live = await turn(calls(['mine_count', {}]), { settings: { ...SETTINGS, deferTools: false } });
  assert(live.offered.includes('mine_count') && live.results.some(r => /counted/.test(r)), 'enabled → offered and runs');
  const upd = await T.executeToolManage({
    action: 'update',
    definition: { name: 'mine_count', description: 'Count lines, changed.', input_schema: schema({}), run: { argv: [NODE, ARGV_JS, 'changed'] }, effect: 'read' },
  }, { cwd: tmp });
  assert(/took it out of use/.test(upd), 'updating an enabled tool says it took it out of use');
  const changed = (await T.loadCustomTools(tmp)).find(t => t.name === 'mine_count');
  assert(changed.status === 'changed', 'an edit after enabling → changed');
  const gone = await turn(calls(['mine_count', {}]), { settings: { ...SETTINGS, deferTools: false } });
  assert(!gone.offered.includes('mine_count'), 'and out of the run until re-enabled');
  const panel = await T.handleSystemRoute('custom-tools', 'GET', {});
  assert(Array.isArray(panel.body.tools) && panel.body.tools.some(t => t.name === 'mine_count' && t.status === 'changed' && typeof t.command === 'string'), 'the Settings panel route lists tools with status and command');
  const nonRead = await T.handleSystemRoute('manage', 'POST', { registry: 'tools', action: 'test', name: 'demo_exec', args: {} }, undefined, person);
  assert(/Not executed: a exec tool runs only from a turn/.test(nonRead.body.result), 'a person\'s test of a non-read tool stops at the dry run');
});

console.log(`\nPhase 2 custom tools: ${passed} passed, ${failed} failed`);
if (failed) { console.log(failures.map(f => `  - ${f}`).join('\n')); process.exit(1); }
process.exit(0);
