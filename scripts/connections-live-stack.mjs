/**
 * A local stand-in for GitHub Enterprise Server, for looking at Connections in the real app
 * without a real provider (ADR 0039, "Live verification"). NOT part of `npm test`.
 *
 * It starts, on one 127.0.0.1 port: the mock forge serving the `dotcom` fixtures under
 * `/api/v3` (with the clone URL pointed at this same port and the first pull request numbered 1),
 * and a real `git http-backend` serving the bare repository `octo-org/widgets.git` behind HTTP
 * Basic auth. It also prepares a small git project whose `origin` is that repository, so the
 * Delivery board, the Connections page and a real push can all be exercised against the real
 * engine. It prints one JSON line (`origin`, `token`, `project`, `policy`) and then waits.
 *
 *   node scripts/connections-live-stack.mjs [--dir <folder>] [--port <n>]
 *
 * Then, with an isolated store (never ~/.aico):
 *   AICO_HOME=<folder>/home/.aico AICO_POLICY_FILE=<policy printed> node dist/index.js serve --port 7340
 * The policy file is an allow-list for the mock host only (the managed `connections` key).
 *
 * Nothing real is contacted; the token is a canary. Offline.
 */

import { testHome } from './lib/test-home.mjs';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitHttpHandler } from './lib/git-http-server.mjs';
import { startMockForge } from './lib/mock-forge.mjs';

void testHome;
const here = path.dirname(fileURLToPath(import.meta.url));
const argDir = process.argv.indexOf('--dir');
const root = argDir > 0 ? path.resolve(process.argv[argDir + 1]) : fs.mkdtempSync(path.join(os.tmpdir(), 'aico-live-stack-'));
fs.mkdirSync(root, { recursive: true });
const TOKEN = 'ghp_LiveStackCanary0123456789abcdefABCDEF'; // standards-allow: secret (test canary)
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// The fixtures: dotcom, with the clone URL on this port and the created pull request numbered 1.
const fixtures = path.join(root, 'fixtures');
fs.cpSync(path.join(here, 'fixtures', 'connections', 'github'), fixtures, { recursive: true });
const account = path.join(fixtures, 'dotcom', 'account.routes.json');
fs.writeFileSync(account, fs.readFileSync(account, 'utf8').replace('https://forge.test/octo-org/widgets.git', '{{origin}}/octo-org/widgets.git'));
const created = path.join(fixtures, 'dotcom', 'pull-created.json');
fs.writeFileSync(created, fs.readFileSync(created, 'utf8').replace(/"number": 7/g, '"number": 1').replace(/pull\/7/g, 'pull/1').replace(/pulls\/7/g, 'pulls/1'));

// A branch with no pull request yet answers "none", whatever its name (the fixture knows one task branch).
const pulls = path.join(fixtures, 'dotcom', 'pulls.routes.json');
const pullDoc = JSON.parse(fs.readFileSync(pulls, 'utf8'));
pullDoc.routes[0].query.head = '*';
pullDoc.routes[0].responses = [{ status: 200, body: [] }];
fs.writeFileSync(pulls, JSON.stringify(pullDoc, null, 2));

const mock = await startMockForge({ fixtures, scenario: 'dotcom', token: TOKEN });
const remoteRoot = path.join(root, 'remote');
const bare = path.join(remoteRoot, 'octo-org', 'widgets.git');
fs.mkdirSync(path.dirname(bare), { recursive: true });
git(remoteRoot, 'init', '--bare', '-q', '-b', 'main', bare);
git(bare, 'config', 'http.receivepack', 'true');
const gitLog = [];
const handleGit = gitHttpHandler({ root: remoteRoot, token: TOKEN, log: gitLog });

const server = http.createServer((req, res) => {
  if (req.url?.startsWith('/api/')) {
    // Forward with the original Host so the mock's {{origin}} is this port.
    const up = http.request({ host: '127.0.0.1', port: mock.port, method: req.method, path: req.url, headers: req.headers }, (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
    up.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(up);
    return;
  }
  handleGit(req, res);
});
const argPort = process.argv.indexOf('--port');
await new Promise(r => server.listen(argPort > 0 ? Number(process.argv[argPort + 1]) : 0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

// A small project whose origin is that repository (left alone when this is a restart on the same folder).
const project = path.join(root, 'widgets');
if (!fs.existsSync(path.join(project, '.git'))) {
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  git(project, 'init', '-q', '-b', 'main');
  git(project, 'config', 'user.name', 'Octo Dev'); git(project, 'config', 'user.email', 'octo@example.test'); git(project, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'widgets', version: '1.0.0', scripts: { test: 'node check.js' } }, null, 2));
  fs.writeFileSync(path.join(project, 'check.js'), "console.log('ok');\n");
  fs.writeFileSync(path.join(project, 'src', 'widget.js'), 'exports.widget = () => 1;\n');
  fs.writeFileSync(path.join(project, '.gitignore'), '.aico/\nnode_modules/\n');
  git(project, 'add', '-A'); git(project, 'commit', '-q', '-m', 'chore: initial');
  git(project, 'remote', 'add', 'origin', `${origin}/octo-org/widgets.git`);
  git(project, 'push', '-q', bare, 'main');

}

const policy = path.join(root, 'policy.json');
fs.writeFileSync(policy, JSON.stringify({ connections: { mode: 'allow-list', providers: ['github'], hosts: ['127.0.0.1'] } }));
fs.writeFileSync(path.join(root, 'stack.json'), JSON.stringify({ origin, token: TOKEN, project, policy, root }, null, 2));
console.log(JSON.stringify({ origin, token: TOKEN, project, policy, root }));
setInterval(() => undefined, 60_000);
