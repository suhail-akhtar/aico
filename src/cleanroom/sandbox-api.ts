/**
 * The API sandbox: send requests to a base URL, read the responses.
 *
 * The simplest adapter and the one with the most exact parity: a response is a
 * status, headers and a body, and two services either answer the same or they
 * do not. It uses Node's `fetch` directly, follows no redirects (a redirect is
 * part of the contract, so it is observed, not hidden) and caps the body it
 * keeps. Nothing here limits where it may point or how fast; that is the
 * operator's call (ADR 0041).
 *
 * @module cleanroom/sandbox-api
 */

import { createHash } from 'node:crypto';
import type { LaunchSpec, Observation, Sandbox, StateFingerprint, Stimulus } from './types.js';
import { WebSandbox } from './sandbox-web.js';
import { CliSandbox } from './sandbox-cli.js';

const BODY_CAP = 500_000;

export class ApiSandbox implements Sandbox {
  readonly kind = 'api' as const;
  private spec!: Extract<LaunchSpec, { kind: 'api' }>;
  private last: Observation = { at: new Date().toISOString(), kind: 'api' };

  async start(spec: LaunchSpec): Promise<void> {
    if (spec.kind !== 'api') throw new Error('ApiSandbox starts an api target');
    this.spec = spec;
  }

  async inject(s: Stimulus): Promise<void> {
    if (s.type === 'wait') { await new Promise(r => setTimeout(r, Math.min(s.ms, 30_000))); return; }
    if (s.type !== 'request') throw new Error(`an API target cannot take a "${s.type}" stimulus`);
    const started = Date.now();
    const url = new URL(s.path, this.spec.baseUrl.endsWith('/') ? this.spec.baseUrl : this.spec.baseUrl + '/').toString();
    const headers: Record<string, string> = { ...this.spec.headers, ...s.headers };
    let body: string | undefined;
    if (s.body !== undefined) {
      body = typeof s.body === 'string' ? s.body : JSON.stringify(s.body);
      if (typeof s.body !== 'string' && !Object.keys(headers).some(h => h.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json';
    }
    try {
      // security-allow: fetch-unguarded — the URL is the operator's own chosen target; pointing this at a local or private service is the use (ADR 0041)
      const res = await fetch(url, { method: s.method, headers, ...(body !== undefined ? { body } : {}), redirect: 'manual', signal: AbortSignal.timeout(this.spec.timeoutMs ?? 15_000) });
      const text = (await res.text()).slice(0, BODY_CAP);
      const h: Record<string, string> = {};
      res.headers.forEach((v, k) => { h[k] = v; });
      this.last = { at: new Date().toISOString(), kind: 'api', durationMs: Date.now() - started, response: { status: res.status, headers: h, body: text, contentType: (h['content-type'] ?? '').split(';')[0] } };
    } catch (e) {
      this.last = { at: new Date().toISOString(), kind: 'api', durationMs: Date.now() - started, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async observe(): Promise<Observation> { return this.last; }

  async snapshot(): Promise<StateFingerprint> {
    const r = this.last.response;
    return createHash('sha256').update(r ? `${r.status}|${r.contentType}|${r.body.length}` : 'none').digest('hex').slice(0, 16);
  }

  async stop(): Promise<void> { /* stateless */ }
}

export function createSandbox(kind: LaunchSpec['kind']): Sandbox {
  if (kind === 'web') return new WebSandbox();
  if (kind === 'cli') return new CliSandbox();
  return new ApiSandbox();
}
