/**
 * The Apps routes, against a real `aico serve` on a store of its own.
 *
 * What the harness cannot prove: that the catalogue route reads the shipped
 * templates from `dist/templates`, that `POST /api/apps/create` makes the app,
 * binds its conversation and answers with both, that the listing carries kind
 * and backlog progress, that a page app has no process to run, and that the
 * old `miniapps/*` names still answer.
 *
 * Run: npm run build && node scripts/apps-live.mjs
 */

// A store of this process's own — nothing below may touch ~/.aico. Must stay first.
import './lib/test-home.mjs';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import os from 'os';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const entry = path.join(root, 'dist', 'index.js');

let passed = 0, failed = 0;
const fails = [];
function check(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; fails.push(label); console.log(`  ✗ ${label}`); }
}

if (!fs.existsSync(entry)) {
  console.error(`\nNo build at ${entry}. Run: npm run build\n`);
  process.exit(1);
}

/*
  The scratch store copied the real settings.json, which may name the reader's
  real workspace. Apps are created under `workspace.path`, so that is pointed
  at a directory of this probe's own before the server starts — otherwise a
  probe would leave "invoice-desk" in somebody's actual workspace.
*/
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-apps-live-'));
const workspace = path.join(workdir, 'workspace');
fs.mkdirSync(workspace, { recursive: true });
const settingsFile = path.join(process.env.AICO_HOME, 'settings.json');
const settings = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : {};
settings.workspace = { ...(settings.workspace ?? {}), path: workspace };
settings.miniApps = { ...(settings.miniApps ?? {}), enabled: true };
delete settings.projects;
fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));

let server;
function killPid(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F']);
    else process.kill(pid, 'SIGKILL');
  } catch { /* already gone */ }
}

function startServe() {
  return new Promise((resolve, reject) => {
    const logFile = path.join(workdir, 'serve.log');
    const out = fs.openSync(logFile, 'a');
    const proc = spawn(process.execPath, [entry, 'serve', '--no-open'], {
      cwd: workdir,
      stdio: ['ignore', out, out],
      env: { ...process.env },
    });
    const deadline = Date.now() + 90_000;
    const poll = setInterval(() => {
      const text = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
      const match = /http:\/\/127\.0\.0\.1:(\d+)\/\?token=([A-Za-z0-9_-]+)/.exec(text);
      if (match) {
        clearInterval(poll);
        resolve({ proc, token: match[2], port: Number(match[1]), log: () => fs.readFileSync(logFile, 'utf8') });
      } else if (Date.now() > deadline) {
        clearInterval(poll);
        reject(new Error(`server never became ready:\n${text.slice(-500)}`));
      }
    }, 500);
  });
}

async function api(route, init = {}) {
  const res = await fetch(`http://127.0.0.1:${server.port}/api/${route}`, {
    ...init,
    headers: { 'x-aico-token': server.token, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text };
}
const post = (route, body) => api(route, { method: 'POST', body: JSON.stringify(body) });

try {
  server = await startServe();

  console.log('\n-- the catalogue comes from the shipped templates --');
  {
    const r = await api('apps/templates');
    const ids = (r.json?.templates ?? []).map(t => t.id).sort();
    check(r.status === 200 && ids.includes('page-records') && ids.includes('web-saas-next'), `GET apps/templates lists the shipped templates (${ids.join(', ')})`);
    const t = r.json.templates.find(t => t.id === 'api-service-hono');
    check(t?.kind === 'process' && t.run?.dev && t.dir === undefined, 'a template carries kind and run profile, and does not leak its directory');
  }

  console.log('\n-- create makes the app, binds the conversation, answers with both --');
  let slug;
  {
    const bad = await post('apps/create', { title: 'X' });
    check(bad.status === 400, 'create without a template is a 400');
    const unknown = await post('apps/create', { template: 'nope', title: 'X' });
    check(unknown.status === 404, 'an unknown template is a 404');
    const made = await post('apps/create', { template: 'page-records', title: 'Reading Log', description: 'Books read', install: false });
    check(made.status === 200 && made.json?.slug === 'reading-log', `create answers with the slug (${made.status} ${made.text.slice(0, 80)})`);
    check(made.json?.sessionId === 'miniapp-reading-log', 'and the bound session id');
    check(made.json?.app?.kind === 'page' && made.json.app.template?.id === 'page-records' && made.json.app.category === 'internal-tool', 'and the app as the store describes it');
    slug = made.json?.slug;
    const dir = path.join(workspace, 'miniapps', slug ?? 'reading-log');
    check(fs.existsSync(path.join(dir, 'public', 'index.html')) && fs.existsSync(path.join(dir, 'schema.sql')) && fs.existsSync(path.join(dir, 'AICO.md')), 'the files landed in the scratch workspace');
    check(fs.readFileSync(path.join(dir, 'README.md'), 'utf8').startsWith('# Reading Log'), 'with the title substituted');
    check(!fs.existsSync(path.join(dir, 'template.json')), 'and without the manifest');
  }

  console.log('\n-- the listing carries kind, category and backlog progress --');
  {
    const r = await api('apps');
    const app = (r.json?.apps ?? []).find(a => a.slug === slug);
    check(r.status === 200 && app, 'GET apps lists the new app');
    check(app?.kind === 'page' && app?.category === 'internal-tool', 'with its kind and category');
    check(app?.backlog?.total >= 4 && app.backlog.done >= 1, `with backlog progress (${app?.backlog?.done}/${app?.backlog?.total})`);
    check(app?.built === true, 'and built, because the template brought its page');
    const legacy = await api('miniapps');
    check(legacy.status === 200 && (legacy.json?.apps ?? []).some(a => a.slug === slug), 'the old miniapps route still answers');
    const host = r.json?.host;
    check(typeof host === 'string' && host.startsWith('http://'), `the host is up (${host})`);
    if (host) {
      const page = await fetch(`${host}/${slug}/`).then(r => r.text()).catch(() => '');
      check(page.includes('Reading Log'), 'and serves the page-records page with the title in it');
      const tables = await fetch(`${host}/${slug}/api/tables`).then(r => r.json()).catch(() => null);
      check(Array.isArray(tables) && tables[0]?.name === 'records', 'and the schema applied');
    }
  }

  console.log('\n-- the project profile: seeded by the template, edited by a person --');
  {
    const dir = path.join(workspace, 'miniapps', slug);
    const r = await api(`project/profile?cwd=${encodeURIComponent(dir)}`);
    check(r.status === 200 && r.json?.cwd, 'GET project/profile answers for the app directory');
    check(r.json?.profile?.stack?.source === 'template', `the stack label comes from the template (${r.json?.profile?.stack?.value})`);
    check(Array.isArray(r.json?.names) && r.json.names.includes('test'), 'and the route lists the command names');
    const set = await post('project/profile', { cwd: dir, name: 'test', command: 'npm run test:fast' });
    check(set.status === 200 && set.json?.profile?.commands?.test?.source === 'user', 'a POST sets a command at user rank');
    const bad = await post('project/profile', { cwd: dir, name: 'nope', command: 'x' });
    check(bad.status === 400, 'an unknown command name is a 400');
    const forgot = await post('project/profile', { cwd: dir, name: 'test', forget: true });
    check(forgot.status === 200 && forgot.json?.profile?.commands?.test === undefined, 'forget removes it');
    check(fs.existsSync(path.join(dir, '.aico', 'profile.json')), 'the profile lives in the app’s .aico/profile.json');
  }

  console.log('\n-- learning and economy routes answer on a real server --');
  {
    const dir = path.join(workspace, 'miniapps', slug);
    const list = await api(`learning/list?cwd=${encodeURIComponent(dir)}`);
    check(list.status === 200 && Array.isArray(list.json?.project) && Array.isArray(list.json?.global), 'GET learning/list answers with project and global lists');
    const gone = await post('learning/dismiss', { cwd: dir, id: 'no-such-proposal' });
    check(gone.status === 404, 'dismissing an unknown proposal is a 404');
    const rec = await api('agents/recommendation?model=claude-sonnet-5');
    check(rec.status === 200 && rec.json?.cheap === 'claude-haiku-4-5' && rec.json?.agentModels?.explore === 'claude-haiku-4-5', `the sub-agent recommendation comes from the shared table (${rec.json?.cheap})`);
    const dup = await post('apps/duplicate', { slug, title: 'Reading Log Two' });
    check(dup.status === 200 && dup.json?.slug === 'reading-log-two' && dup.json?.app?.kind === 'page', `duplicate makes a copy under the new name (${dup.text.slice(0, 60)})`);
    check(fs.existsSync(path.join(workspace, 'miniapps', 'reading-log-two', 'public', 'index.html')) && !fs.existsSync(path.join(workspace, 'miniapps', 'reading-log-two', 'data.sqlite')), 'with the files and without the database');
    await post('apps/delete', { slug: 'reading-log-two' });
  }

  console.log('\n-- a page app has no process; the session route rejoins; delete removes --');
  {
    const run = await post('apps/run', { slug, action: 'start' });
    check(run.status === 400 && /served by the shared host/.test(run.json?.error ?? ''), `start on a page app is a 400 that says why (${run.text.slice(0, 80)})`);
    const sess = await post('apps/session', { slug });
    check(sess.status === 200 && sess.json?.sessionId === `miniapp-${slug}`, 'apps/session rejoins the same conversation');
    const gone = await post('apps/delete', { slug });
    check(gone.status === 200 && gone.json?.deleted === true, 'delete removes the app');
    check(!fs.existsSync(path.join(workspace, 'miniapps', slug)), 'including its directory (the database was closed first)');
  }
} catch (err) {
  failed++;
  fails.push(err instanceof Error ? err.message : String(err));
  console.error(err);
} finally {
  if (server) killPid(server.proc.pid);
  await new Promise(r => setTimeout(r, 500));
  try { fs.rmSync(workdir, { recursive: true, force: true }); } catch { /* a handle may linger on Windows */ }
}

console.log(`\napps live: ${passed} passed, ${failed} failed`);
for (const f of fails) console.log(`  ✗ ${f}`);
process.exit(failed ? 1 : 0);
