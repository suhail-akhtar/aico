/**
 * A real git remote over HTTP on 127.0.0.1 for tests: Node in front of `git http-backend`
 * (the CGI that ships with git), with HTTP Basic auth that must carry the expected token.
 *
 * WHY. PR mode's one irreversible step is a `git push`, and the guarantees that matter (only
 * `aico/task-*` refs, never forced, the token delivered through the askpass sink and never in a
 * URL, `.git/config` or argv) are properties of a real git talking to a real server, not of a
 * mock. So the pull-request test pushes to this. The server records every request (URL, whether
 * the credentials were right) so a test can assert that git asked for them and the token only
 * ever travelled in the Authorization header.
 *
 * Repositories live under `root` (`<root>/owner/name.git`, bare). Returns `{ origin, host, log,
 * stop }`; `available` is false when this machine's git has no http-backend (the test then skips).
 */

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

function backendPath() {
  try {
    const exec = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
    for (const name of ['git-http-backend.exe', 'git-http-backend']) {
      const p = path.join(exec, name);
      if (fs.existsSync(p)) return p;
    }
  } catch { /* no git */ }
  return undefined;
}

export const gitHttpAvailable = () => backendPath() !== undefined;

/**
 * The request handler alone, for a caller that serves git on a server it already has (the live
 * stack puts it behind the same port as the mock forge's API). `log` receives one record per request.
 * @param {{ root: string, token: string, log?: any[] }} opts
 */
export function gitHttpHandler({ root, token, log = [] }) {
  const backend = backendPath();
  if (!backend) throw new Error('git http-backend not found');
  const expected = `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
  return (req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const authed = req.headers.authorization === expected;
      log.push({ method: req.method, url: req.url, authed, hadAuth: Boolean(req.headers.authorization) });
      if (!authed) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="git"' }); res.end(); return; }
      const u = new URL(req.url, 'http://x');
      const env = {
        ...process.env,
        GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1', REQUEST_METHOD: req.method, PATH_INFO: u.pathname, QUERY_STRING: u.search.slice(1),
        CONTENT_TYPE: req.headers['content-type'] ?? '', CONTENT_LENGTH: String(body.length), REMOTE_USER: 'x-access-token', REMOTE_ADDR: '127.0.0.1',
        ...(req.headers['content-encoding'] ? { HTTP_CONTENT_ENCODING: req.headers['content-encoding'] } : {}),
        ...(req.headers['git-protocol'] ? { GIT_PROTOCOL: req.headers['git-protocol'] } : {}),
      };
      const child = spawn(backend, [], { env });
      const out = [];
      child.stdout.on('data', c => out.push(c));
      child.stdin.on('error', () => { /* the backend may stop reading early */ });
      child.stdin.end(body);
      child.on('close', () => {
        const raw = Buffer.concat(out);
        const sep = raw.indexOf('\r\n\r\n') >= 0 ? raw.indexOf('\r\n\r\n') : raw.indexOf('\n\n');
        if (sep < 0) { res.writeHead(500); res.end(); return; }
        const head = raw.subarray(0, sep).toString('utf8').split(/\r?\n/);
        const headers = {}; let status = 200;
        for (const line of head) {
          const i = line.indexOf(':'); if (i < 0) continue;
          const k = line.slice(0, i).trim(); const v = line.slice(i + 1).trim();
          if (k.toLowerCase() === 'status') status = Number.parseInt(v, 10) || 200; else headers[k] = v;
        }
        res.writeHead(status, headers);
        res.end(raw.subarray(sep + (raw.indexOf('\r\n\r\n') >= 0 ? 4 : 2)));
      });
    });
  };
}

/** @param {{ root: string, token: string }} opts */
export async function startGitHttp({ root, token }) {
  const log = [];
  const server = http.createServer(gitHttpHandler({ root, token, log }));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return { port, origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, log, stop: () => new Promise(r => server.close(() => r())) };
}
