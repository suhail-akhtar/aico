/**
 * A loopback "forge" that replays hand-written fixtures, so provider adapters are tested
 * against real HTTP (the real client, the real SSRF guard, the real ETag and rate-limit
 * handling) without ever reaching a real service. Used by scripts/connections-conformance.mjs
 * and every provider's test (ADR 0039, "Tests").
 *
 * WHY a server and not stubbed `fetch`. The failures this suite exists to catch live in the
 * transport: a token that leaked into a URL, an ETag that was never sent back, a 304 that the
 * adapter mistook for an empty list, a Retry-After that did not stop the next request. A stub
 * above the transport cannot see any of those. So the mock is a real `http.Server` on
 * 127.0.0.1 on an ephemeral port, and it RECORDS every request so a test can assert on what
 * actually crossed the wire.
 *
 * Nothing here knows any provider. The server is a route table plus four behaviours every
 * forge shares: sequenced responses, ETags with 304, an auth requirement, and a request log.
 *
 * FIXTURE FORMAT. `startMockForge({ fixtures, scenario })` reads every `*.routes.json` file in
 * `<fixtures>/<scenario>/` (sorted by name; routes keep file order; the FIRST match wins, so
 * put specific routes before general ones). A file is an array of routes, or
 * `{ "prefix": "/api/v3", "routes": [...] }` (the prefix is prepended to each route's path).
 *
 *   {
 *     "method": "GET",                              // default GET
 *     "path": "/repos/:owner/:name/pulls/:number",  // :param captures one segment; a trailing * takes the rest
 *     "query": { "state": "open", "page": "*" },    // optional; every key must match ("*" = present)
 *     "bodyIncludes": "\"sha\":\"0000\"",             // optional; the raw request body must contain this
 *     "responses": [                                // consumed in order, one per matching request;
 *       { "status": 200, "headers": {...},          //   the LAST repeats forever; "times": n repeats an
 *         "body": {...} },                          //   earlier one n times before moving on
 *       { "status": 200, "bodyFile": "pull-merged.json" }   // a file beside the routes (raw, templated)
 *     ]
 *   }
 *
 * A route with a single response may put `status`/`headers`/`body`/`text`/`bodyFile` on the route
 * itself. Sequences are counted per route AND concrete path, so `/commits/aaa/check-runs` and
 * `/commits/bbb/check-runs` advance independently. A scenario switch (`setScenario`) resets them.
 *
 * TEMPLATES, expanded in every header value and body (after JSON serialisation, so keep the
 * text free of quotes): `{{origin}}` (`http://127.0.0.1:PORT`), `{{host}}`, `{{param.NAME}}`,
 * `{{epoch+N}}` (now + N seconds, epoch seconds, for X-RateLimit-Reset), `{{repeat:TEXT:N}}`
 * (TEXT N times; a 100 KB body without a 100 KB fixture), `{{tags:TEXT}}` (TEXT as Unicode tag
 * characters U+E0000..E007F, the invisible-instruction trick), `{{zw}}` (a zero-width space).
 *
 * ETAGS. A 200 to a GET with a body gets `ETag: W/"<hash of the body>"` unless the response sets
 * its own or `"etag": false`. A request whose `If-None-Match` matches is answered `304` with no
 * body, as GitHub, Gitea and GitLab do; a sequenced response that changes the body changes the
 * ETag, so a 304 can never hide a change.
 *
 * AUTH. With `requireAuth` (default true) a request without `Authorization: Bearer|token <x>`
 * (and, if `token` is given, the exact value) is answered 401 before any route is consulted.
 * The header is recorded like every other, so a test can assert the credential was sent only
 * there and never in a URL, query or body.
 *
 * RECORDS. `requests` is a live array of `{ method, url, path, query, headers, body, rawBody,
 * status, matched }`; `url` is the raw request target including the query string. A request no
 * route matched is answered 404 `{message:"Not Found (mock: no fixture ...)"}` with
 * `matched:false`, so a test can assert that nothing unexpected was asked.
 *
 * What it does not do: speak TLS (adapters are run with an explicit opt-in to loopback http),
 * validate that a fixture matches a provider's real schema (the hand-written fixtures follow the
 * documented shapes; the owner records real ones later), or serve more than one origin.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const MAX_EXPANDED = 5 * 1024 * 1024;

function readRoutes(dir) {
  if (!fs.existsSync(dir)) throw new Error(`mock-forge: no scenario directory at ${dir}`);
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.routes.json') || f === 'routes.json').sort();
  if (!files.length) throw new Error(`mock-forge: ${dir} has no *.routes.json`);
  const routes = [];
  for (const f of files) {
    const doc = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const prefix = Array.isArray(doc) ? '' : (doc.prefix ?? '');
    const list = Array.isArray(doc) ? doc : doc.routes;
    if (!Array.isArray(list)) throw new Error(`mock-forge: ${f} must be an array or { routes: [] }`);
    for (const r of list) {
      const responses = r.responses ?? [{ status: r.status ?? 200, headers: r.headers, body: r.body, text: r.text, bodyFile: r.bodyFile, etag: r.etag }];
      routes.push({
        method: (r.method ?? 'GET').toUpperCase(),
        segments: (prefix + r.path).split('/').filter(Boolean),
        query: r.query ?? {},
        bodyIncludes: r.bodyIncludes,
        responses,
        file: f,
        label: `${(r.method ?? 'GET').toUpperCase()} ${prefix + r.path}`,
      });
    }
  }
  return routes;
}

function matchPath(segments, actual) {
  const params = {};
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    if (s === '*' && i === segments.length - 1) { params['*'] = actual.slice(i).join('/'); return params; }
    if (i >= actual.length) return undefined;
    if (s.startsWith(':')) params[s.slice(1)] = actual[i];
    else if (s !== actual[i]) return undefined;
  }
  return actual.length === segments.length ? params : undefined;
}

function matchQuery(want, got) {
  for (const [k, v] of Object.entries(want)) {
    if (!(k in got)) return false;
    if (v !== '*' && String(got[k]) !== String(v)) return false;
  }
  return true;
}

/** `{{tags:abc}}` as JSON surrogate-pair escapes of U+E0061.. (valid inside a JSON string). */
function tagEscapes(text) {
  let out = '';
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (c < 0x20 || c > 0x7e) continue;
    out += `\\udb40\\u${(0xdc00 + c).toString(16)}`;
  }
  return out;
}

function expand(text, ctx) {
  let out = String(text)
    .replace(/\{\{repeat:([\s\S]*?):(\d+)\}\}/g, (_m, t, n) => {
      if (t.length * Number(n) > MAX_EXPANDED) throw new Error('mock-forge: {{repeat}} is too large');
      return t.repeat(Number(n));
    })
    .replace(/\{\{tags:([^}]*)\}\}/g, (_m, t) => tagEscapes(t))
    .replace(/\{\{zw\}\}/g, '\\u200b')
    .replace(/\{\{origin\}\}/g, ctx.origin)
    .replace(/\{\{host\}\}/g, ctx.host)
    .replace(/\{\{epoch\+(\d+)\}\}/g, (_m, n) => String(Math.floor(Date.now() / 1000) + Number(n)))
    .replace(/\{\{param\.([A-Za-z0-9_*-]+)\}\}/g, (_m, k) => ctx.params[k] ?? '');
  if (out.length > MAX_EXPANDED) throw new Error('mock-forge: expanded response is too large');
  return out;
}

function pickResponse(responses, count) {
  let n = count;
  for (const r of responses) {
    const t = r.times ?? 1;
    if (n < t) return r;
    n -= t;
  }
  return responses[responses.length - 1];
}

/**
 * @param {{ fixtures: string, scenario?: string, requireAuth?: boolean, token?: string }} opts
 * @returns {Promise<{ url: string, host: string, port: number, requests: object[],
 *   setScenario(name: string): void, reset(): void, stop(): Promise<void> }>}
 */
export async function startMockForge(opts) {
  const { fixtures, requireAuth = true, token } = opts;
  let scenario = opts.scenario;
  const dirOf = (name) => (name ? path.join(fixtures, name) : fixtures);
  let routes = readRoutes(dirOf(scenario));
  let counters = new Map();
  const requests = [];

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      const u = new URL(req.url ?? '/', 'http://mock.invalid');
      const query = {};
      for (const [k, v] of u.searchParams) query[k] = k in query ? [].concat(query[k], v) : v;
      let body;
      if (rawBody) { try { body = JSON.parse(rawBody); } catch { body = rawBody; } }
      const rec = { method: req.method, url: req.url ?? '/', path: u.pathname, query, headers: { ...req.headers }, body, rawBody, status: 0, matched: false };
      requests.push(rec);
      const origin = `http://${req.headers.host ?? '127.0.0.1'}`;
      const finish = (status, headers, text) => {
        rec.status = status;
        res.writeHead(status, headers);
        res.end(status === 204 || status === 304 ? undefined : text);
      };

      if (requireAuth) {
        const m = /^(?:Bearer|token)\s+(\S+)$/i.exec(String(req.headers.authorization ?? ''));
        if (!m) return finish(401, { 'content-type': 'application/json' }, JSON.stringify({ message: 'Requires authentication' }));
        if (token !== undefined && m[1] !== token) return finish(401, { 'content-type': 'application/json' }, JSON.stringify({ message: 'Bad credentials' }));
      }

      const actual = u.pathname.split('/').filter(Boolean).map(s => { try { return decodeURIComponent(s); } catch { return s; } });
      let hit;
      for (let i = 0; i < routes.length; i++) {
        const r = routes[i];
        if (r.method !== req.method) continue;
        const params = matchPath(r.segments, actual);
        if (!params || !matchQuery(r.query, query)) continue;
        if (r.bodyIncludes && !rawBody.includes(r.bodyIncludes)) continue;
        hit = { r, i, params };
        break;
      }
      if (!hit) {
        return finish(404, { 'content-type': 'application/json' }, JSON.stringify({ message: `Not Found (mock: no fixture for ${req.method} ${u.pathname})` }));
      }
      rec.matched = true;
      rec.route = hit.r.label;

      const key = `${hit.i}|${u.pathname}`;
      const count = counters.get(key) ?? 0;
      counters.set(key, count + 1);
      const resp = pickResponse(hit.r.responses, count);
      const ctx = { origin, host: req.headers.host ?? '', params: hit.params };

      let text = '';
      let ctype = 'application/json; charset=utf-8';
      if (resp.bodyFile) text = fs.readFileSync(path.join(dirOf(scenario), resp.bodyFile), 'utf8');
      else if (resp.text !== undefined) { text = String(resp.text); ctype = 'text/plain; charset=utf-8'; }
      else if (resp.body !== undefined) text = JSON.stringify(resp.body);
      try { text = expand(text, ctx); } catch (e) { return finish(500, {}, String(e.message)); }

      const headers = {};
      if (text) headers['content-type'] = ctype;
      for (const [k, v] of Object.entries(resp.headers ?? {})) headers[k.toLowerCase()] = expand(v, ctx);
      const status = resp.status ?? 200;

      if (req.method === 'GET' && status === 200 && text && resp.etag !== false && !headers.etag) {
        headers.etag = `W/"${crypto.createHash('sha1').update(text).digest('hex').slice(0, 16)}"`;
      }
      const inm = req.headers['if-none-match'];
      if (headers.etag && inm && inm.split(',').map(s => s.trim()).includes(headers.etag)) {
        return finish(304, { etag: headers.etag }, '');
      }
      return finish(status, headers, text);
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;

  return {
    url: `http://127.0.0.1:${port}`,
    host: `127.0.0.1:${port}`,
    port,
    requests,
    scenario: () => scenario,
    setScenario(name) { routes = readRoutes(dirOf(name)); scenario = name; counters = new Map(); },
    /** Forget the request log and every response sequence (same scenario). */
    reset() { requests.length = 0; counters = new Map(); },
    async stop() {
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(() => resolve()));
    },
  };
}
