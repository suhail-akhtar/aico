/**
 * End-to-end smoke of the running system (`docker compose up --wait` first): a real browser-style
 * sign-in through Keycloak, a task through the gateway, the outbox delivering the assignment mail,
 * and the audit trail recording it.
 *
 * Why plain HTTP and not a headless browser: the point is to prove the wiring (Traefik routes, the
 * OIDC issuer the API and the browser both see, the cookie session, CSRF, the transactional outbox,
 * the audit listener) in a few seconds with no extra image. The React screens have their own tests.
 * Hostnames on the `.localhost` zone are not resolvable everywhere, so every request goes to
 * 127.0.0.1 with the intended Host header and a small cookie jar keyed by that host.
 *
 * Reads ports and the dev password from the environment or from ./.env (no secret is printed).
 * Exit code 0 only when every check passed.
 */
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env };
const envFile = resolve(root, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m && env[m[1]] === undefined) env[m[1]] = m[2];
  }
}
const APP_PORT = env.APP_PORT || '8080';
const MAILPIT_PORT = env.MAILPIT_PORT || '8025';
const BASE = `http://localhost:${APP_PORT}`;
const PASSWORD = env.DEV_USER_PASSWORD;
if (!PASSWORD) {
  console.error('DEV_USER_PASSWORD is not set (run make setup, or export it).');
  process.exit(2);
}

let passed = 0;
let failed = 0;
function check(ok, label, detail) {
  if (ok) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`);
  }
  return ok;
}

/** One request to 127.0.0.1 carrying the logical Host (fetch cannot override Host; node:http can). */
function send(u, method, headers, body) {
  return new Promise((resolveReq, reject) => {
    const req = http.request({ host: '127.0.0.1', port: u.port || 80, path: u.pathname + u.search, method, headers, timeout: 20_000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolveReq({ status: res.statusCode, headers: res.headers, setCookies: res.headers['set-cookie'] ?? [], text: Buffer.concat(chunks).toString('utf8') }),
      );
    });
    req.on('timeout', () => req.destroy(new Error(`timeout: ${method} ${u.href}`)));
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** One browser: cookies per logical host, redirects followed by hand so each hop is visible. */
class Browser {
  jar = new Map();
  async request(url, { method = 'GET', headers = {}, body, follow = true } = {}) {
    for (let hop = 0; hop < 12; hop++) {
      const u = new URL(url);
      const cookies = [...(this.jar.get(u.hostname) ?? new Map())].map(([k, v]) => `${k}=${v}`).join('; ');
      const res = await send(u, method, { host: u.host, ...(cookies ? { cookie: cookies } : {}), ...headers }, body);
      const jar = this.jar.get(u.hostname) ?? new Map();
      for (const c of res.setCookies) {
        const [pair, ...attrs] = c.split(';');
        const eq = pair.indexOf('=');
        const name = pair.slice(0, eq).trim();
        const expired = attrs.some((a) => /^\s*max-age=0/i.test(a));
        if (expired || pair.slice(eq + 1) === '') jar.delete(name);
        else jar.set(name, pair.slice(eq + 1).trim());
      }
      this.jar.set(u.hostname, jar);
      const loc = res.headers.location;
      if (follow && res.status >= 300 && res.status < 400 && loc) {
        url = new URL(loc, url).href;
        method = 'GET';
        body = undefined;
        continue;
      }
      const text = res.text;
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        /* not JSON */
      }
      return { status: res.status, text, json, url, headers: res.headers };
    }
    throw new Error('too many redirects');
  }
  cookie(host, name) {
    return this.jar.get(host)?.get(name);
  }
}

const unescapeHtml = (s) => s.replace(/&amp;/g, '&').replace(/&#x3D;/g, '=').replace(/&quot;/g, '"');

async function signIn(username) {
  const b = new Browser();
  const login = await b.request(`${BASE}/oauth2/authorization/keycloak`);
  const form = /<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"/.exec(login.text) ?? /<form[^>]*action="([^"]+)"[^>]*id="kc-form-login"/.exec(login.text);
  if (!form) throw new Error(`no Keycloak login form (status ${login.status}, ${login.url})`);
  const done = await b.request(unescapeHtml(form[1]), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username, password: PASSWORD, credentialId: '' }).toString(),
  });
  return { b, landed: done };
}

async function api(b, method, path, body) {
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const xsrf = b.cookie('localhost', 'XSRF-TOKEN');
  if (method !== 'GET' && xsrf) headers['x-xsrf-token'] = decodeURIComponent(xsrf);
  return b.request(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), follow: false });
}

async function waitFor(fn, ms, every = 500) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    await new Promise((r) => setTimeout(r, every));
  }
  return undefined;
}

console.log(`smoke: ${BASE}`);
try {
  // 1. Anonymous callers: the session endpoint answers, the API does not.
  const anon = new Browser();
  const s0 = await anon.request(`${BASE}/api/v1/session`, { follow: false });
  check(s0.status === 200 && s0.json?.authenticated === false, 'anonymous /api/v1/session answers authenticated=false');
  const t0 = await api(anon, 'GET', '/api/v1/tasks');
  check(t0.status === 401, 'anonymous /api/v1/tasks is 401', `status ${t0.status}`);
  const web = await anon.request(`${BASE}/`, { follow: false });
  check(web.status === 200 && /<div id="root"/.test(web.text), 'the single-page app is served at /');

  // 2. Sign in through Keycloak (authorization code flow, BFF cookie session).
  const alice = await signIn('alice');
  const sess = await api(alice.b, 'GET', '/api/v1/session');
  check(sess.json?.authenticated === true && sess.json?.user?.email === 'alice@example.com', 'alice signs in through Keycloak and the API sees her', `status ${sess.status} ${sess.text.slice(0, 200)}`);
  check(Array.isArray(sess.json?.user?.roles) && sess.json.user.roles.includes('ADMIN'), 'alice carries the ADMIN role from the realm', JSON.stringify(sess.json?.user?.roles));
  check(sess.json?.features?.maxOpenTasksPerUser === 100, 'flagd targeting is live (an admin gets the admin task limit, not the default)', JSON.stringify(sess.json?.features));
  check(Boolean(alice.b.cookie('localhost', 'XSRF-TOKEN')), 'the CSRF cookie is issued');

  // 3. A write without the CSRF header is refused; with it, the task is created.
  const noCsrf = await alice.b.request(`${BASE}/api/v1/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'no csrf' }),
    follow: false,
  });
  check(noCsrf.status === 403, 'a cookie-authenticated POST without the CSRF header is 403', `status ${noCsrf.status}`);
  const title = `Smoke ${Date.now()}`;
  const created = await api(alice.b, 'POST', '/api/v1/tasks', { title, description: 'created by scripts/smoke.mjs', assigneeEmail: 'bob@example.com' });
  check(created.status === 201 && created.json?.id, 'alice creates a task assigned to bob', `status ${created.status} ${created.text.slice(0, 300)}`);
  const taskId = created.json?.id;

  // 4. The outbox: the assignment event is delivered after commit, so bob's mail reaches Mailpit.
  const mail = await waitFor(async () => {
    const r = await send(new URL(`http://127.0.0.1:${MAILPIT_PORT}/api/v1/messages`), 'GET', {});
    const j = JSON.parse(r.text);
    return j.messages?.find((m) => m.Subject?.includes(title) && m.To?.some((t) => t.Address === 'bob@example.com'));
  }, 30_000);
  check(Boolean(mail), 'the outbox delivered the assignment mail to bob (seen in Mailpit)');

  // 5. The audit trail: an administrator reads it; a member may not.
  const audit = await waitFor(async () => {
    const r = await api(alice.b, 'GET', '/api/v1/admin/audit?size=50');
    return r.json?.items?.find((e) => e.targetId === taskId);
  }, 15_000);
  check(Boolean(audit), 'the audit trail has an entry for the new task', audit ? '' : 'not found in /api/v1/admin/audit');
  if (audit) check(audit.actorLabel && audit.requestId, 'the audit entry names the actor and the request id', JSON.stringify(audit));

  const bob = await signIn('bob');
  const bobAudit = await api(bob.b, 'GET', '/api/v1/admin/audit');
  check(bobAudit.status === 403, "a member cannot read the audit trail (403)", `status ${bobAudit.status}`);
  const bobSeesAlice = await api(bob.b, 'GET', `/api/v1/tasks/${taskId}`);
  check(bobSeesAlice.status === 404, "another user's task is 404, not 403 (no existence leak)", `status ${bobSeesAlice.status}`);

  // 6. Sign out ends the session.
  const out = await api(alice.b, 'POST', '/api/v1/session/logout');
  const after = await api(alice.b, 'GET', '/api/v1/session');
  check(after.json?.authenticated === false || out.status >= 400, 'after sign-out the session is anonymous', `logout ${out.status}, session ${after.text.slice(0, 120)}`);
} catch (e) {
  check(false, 'smoke ran to the end', e.stack ?? String(e));
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
