#!/usr/bin/env node
/**
 * Tests for the security scan (scripts/security-scan.mjs) and the shared
 * rules it runs (shared/security/rules.mjs).
 *
 * A scanner is only as good as its two failure modes: missing the thing it
 * exists to catch, and firing on safe code until people stop reading it. So
 * every rule gets a case that must fire and a near-miss that must not, and the
 * baseline gets the property CI depends on — a recorded finding passes, a new
 * one fails, an edit above a finding does not make it new.
 *
 * Offline and self-contained: fixtures are written to a temp directory and the
 * scan is pointed at it with --root. Nothing key-shaped appears in this
 * source; canaries are assembled at runtime.
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { scanCode, findSecrets, codeOnly } from '../shared/security/rules.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
let passed = 0; let failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log(`  ok    ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}`); }
}
const rulesIn = (file, src) => scanCode(file, src).map(f => f.rule);
const fires = (rule, file, src) => ok(rulesIn(file, src).includes(rule), `${rule} fires: ${src.split('\n').pop().trim().slice(0, 70)}`);
const quiet = (rule, file, src) => ok(!rulesIn(file, src).includes(rule), `${rule} quiet: ${src.split('\n').pop().trim().slice(0, 70)}`);

console.log('\n── generic rules ──');
const cp = "import { exec, execSync } from 'child_process';\n";
fires('exec-interpolated', 'a.ts', cp + 'exec(`git log ${branch}`);');
fires('exec-interpolated', 'a.ts', cp + "execSync('rm -rf ' + dir);");
fires('exec-interpolated', 'a.ts', cp + 'exec(command, cb);');
quiet('exec-interpolated', 'a.ts', cp + "execSync('git status');");
quiet('exec-interpolated', 'a.ts', 'const m = re.exec(`${x}`);');
fires('shell-true', 'a.ts', "spawn(cmd, args, { shell: true });");
fires('eval', 'a.ts', 'const v = eval(input);');
fires('eval', 'a.ts', "const f = new Function('a', body);");
quiet('eval', 'a.ts', 'await page.evaluate(() => 1);');
quiet('eval', 'a.ts', "const s = 'never eval(x) here';");
fires('inner-html', 'a.tsx', 'el.innerHTML = userText;');
fires('inner-html', 'a.tsx', '<div dangerouslySetInnerHTML={{ __html: html }} />');
quiet('inner-html', 'a.tsx', "el.innerHTML = '';");
quiet('inner-html', 'a.tsx', 'const html = el.innerHTML;');
quiet('inner-html', 'a.tsx', '<span dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(x) }} />');
fires('tls-verify-off', 'a.ts', 'https.request({ rejectUnauthorized: false });');
fires('tls-verify-off', 'a.ts', "process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';");
fires('tls-verify-off', 'a.py', 'requests.get(url, verify=False)');
fires('tls-verify-off', 'a.go', 'cfg := &tls.Config{InsecureSkipVerify: true}');
quiet('tls-verify-off', 'a.ts', "const msg = 'set rejectUnauthorized: false at your peril';");
fires('weak-random-secret', 'a.ts', 'const token = Math.random().toString(36);');
quiet('weak-random-secret', 'a.ts', 'const jitter = Math.random() * 100;');
fires('secret-in-log', 'a.ts', 'console.log(`key: ${apiKey}`);');
fires('secret-in-log', 'a.ts', 'console.error(token);');
quiet('secret-in-log', 'a.ts', "console.log('token refreshed');");
quiet('secret-in-log', 'a.ts', 'console.log(`stored ${credential.name}`);');
quiet('secret-in-log', 'a.ts', 'console.log(`length ${token.length}`);');
fires('sql-interpolated', 'a.ts', 'db.query(`SELECT * FROM users WHERE id = ${id}`);');
fires('sql-interpolated', 'a.py', 'cur.execute(f"SELECT * FROM users WHERE id = {uid}")');
fires('sql-interpolated', 'a.py', 'cur.execute("SELECT * FROM t WHERE a = %s" % a)');
quiet('sql-interpolated', 'a.ts', "db.query('SELECT * FROM users WHERE id = ?', [id]);");
fires('py-shell', 'a.py', 'subprocess.run(cmd, shell=True)');
fires('py-shell', 'a.py', 'os.system("ls " + d)');
quiet('py-shell', 'a.py', "subprocess.run(['ls', d])");
fires('py-eval', 'a.py', 'x = eval(data)');
quiet('py-eval', 'a.py', 'x = ast.literal_eval(data)');
fires('py-unsafe-deserialise', 'a.py', 'obj = pickle.loads(blob)');
fires('py-unsafe-deserialise', 'a.py', 'cfg = yaml.load(f)');
quiet('py-unsafe-deserialise', 'a.py', 'cfg = yaml.load(f, Loader=yaml.SafeLoader)');
fires('go-shell', 'a.go', 'exec.Command("sh", "-c", cmd)');

console.log('\n── comments, strings, waivers ──');
quiet('eval', 'a.ts', '// eval(x) is how not to do it');
quiet('eval', 'a.ts', '/*\n eval(x)\n*/');
quiet('eval', 'a.ts', 'const prompt = `\n  never call eval(x) or new Function(y)\n`;');
fires('eval', 'a.ts', 'const prompt = `\n  text\n`;\neval(x);');
quiet('eval', 'a.ts', 'eval(x); // security-allow: eval — fixed table of expressions');
quiet('eval', 'a.ts', '// security-allow: eval — reviewed\neval(x);');
fires('eval', 'a.ts', '// security-allow: shell-true — wrong rule\neval(x);');
ok(codeOnly("console.log('a', `b ${c} d`)") === "console.log('', `${c}`)", 'codeOnly keeps template expressions, blanks literal text');

console.log('\n── secrets ──');
const fakeKey = ['sk', 'ant', 'api03', 'Qz7Kp2Lm9Xw4Rt8Vb6Ny3Hc5Jd1Fg0SeAoUiPlMkNjBhGvTy'].join('-');
ok(findSecrets(`const k = '${fakeKey}';`).length === 1, 'a key-shaped value is found');
ok(!JSON.stringify(findSecrets(`const k = '${fakeKey}';`)).includes(fakeKey.slice(8)), 'a finding never carries the value');
ok(findSecrets(`const k = '${fakeKey}'; // security-allow: secret — test canary`).length === 0, 'security-allow: secret waives a line');

console.log('\n── baseline and repository checks (temp tree) ──');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-secscan-'));
const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
write('scripts/security/routes.json', JSON.stringify({ routes: { ping: { gate: 'token' } } }));
write('scripts/security/settings-keys.json', JSON.stringify({ critical: { autoApprove: 'x' } }));
write('src/server/index.ts', "if (route === 'ping') {}\n");
write('src/settings.ts', 'export interface AicoSettings {\n  autoApprove?: boolean;\n  theme?: string;\n}\n');
write('src/settings-project-policy.ts', "export const PROJECT_POLICY = {\n  autoApprove: 'user-only',\n  theme: 'allow',\n} as const satisfies X;\n");
write('src/a.ts', "import { execSync } from 'child_process';\nexecSync('ls ' + dir);\n");
const scan = (...args) => {
  try { return { code: 0, out: execFileSync(process.execPath, [path.join(here, 'security-scan.mjs'), '--root', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; }
  catch (e) { return { code: e.status, out: `${e.stdout}${e.stderr}` }; }
};
let r = scan();
ok(r.code === 1 && /exec-interpolated/.test(r.out), 'a new finding fails the scan');
scan('--update-baseline');
r = scan();
ok(r.code === 0, 'the same finding passes once baselined');
write('src/a.ts', "import { execSync } from 'child_process';\n// a comment that moves the line\nconst x = 1;\nexecSync('ls ' + dir);\n");
ok(scan().code === 0, 'an edit above a baselined finding does not make it new');
write('src/a.ts', "import { execSync } from 'child_process';\nexecSync('ls ' + dir);\nexecSync('rm ' + other);\n");
ok(scan().code === 1, 'a second, different finding in the same file is new');
write('src/a.ts', "import { execSync } from 'child_process';\nexecSync('ls ' + dir);\n");
write('src/server/index.ts', "if (route === 'ping') {}\nif (route === 'danger/new') {}\n");
r = scan();
ok(r.code === 1 && /route-unregistered/.test(r.out) && /danger\/new/.test(r.out), 'an unclassified /api route fails');
write('src/server/index.ts', "if (route === 'ping') {}\n");
write('src/settings-project-policy.ts', "export const PROJECT_POLICY = {\n  autoApprove: 'allow',\n  theme: 'allow',\n} as const satisfies X;\n");
r = scan();
ok(r.code === 1 && /settings-key-unfiltered/.test(r.out), 'a critical settings key a project may set fails');
write('src/settings-project-policy.ts', "export const PROJECT_POLICY = {\n  autoApprove: 'user-only',\n} as const satisfies X;\n");
r = scan();
ok(r.code === 1 && /settings-key-unclassified/.test(r.out), 'a settings key missing from the policy table fails');
fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n  SECURITY SCAN: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
