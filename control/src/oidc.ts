/**
 * OpenID Connect, as a relying party: authorization code + PKCE (S256).
 *
 * The server never sees a password; the tenant's identity provider (Entra ID,
 * Okta, Google, Keycloak, anything with a discovery document) authenticates the
 * person and hands back an ID token, which is checked here and nowhere else:
 *
 *  - the signature, against the IdP's JWKS, with the algorithm taken from our
 *    allow-list (RS256, ES256) and never from the token alone — `none` and
 *    `HS*` (a public key misused as an HMAC secret) are refused outright;
 *  - `iss` equals the configured issuer, `aud` contains our client id, `exp`
 *    is in the future (60 s of skew), `iat` is not in the future, `nonce`
 *    equals the one we put in the flow, and `azp` (when present with several
 *    audiences) is our client.
 *
 * The outbound requests (discovery, JWKS, token) go through `idpFetch`: https
 * only (loopback http only when the server was started with
 * `--allow-insecure-idp`, which is for tests and local demos), no redirects,
 * link-local and cloud-metadata addresses refused, 10 s timeout, 1 MB cap. The
 * URL always comes from the tenant's configuration, never from a request.
 *
 * Deliberately not here: SAML, the userinfo endpoint, refresh of IdP tokens
 * (we keep our own session), logout propagation to the IdP.
 *
 * @module oidc
 */

import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { pkceChallenge, randomToken } from './crypto.js';

export class OidcError extends Error {
  constructor(message: string, readonly code = 'oidc') { super(message); this.name = 'OidcError'; }
}

export interface Discovery { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string }
interface Jwk extends crypto.JsonWebKey { kid?: string; use?: string; alg?: string }

export interface IdpConfig { issuer: string; clientId: string; clientSecret?: string; scopes?: string }
export interface OidcOptions { allowInsecureIdp?: boolean; now?: () => number }

// ── the one outbound door ───────────────────────────────────────────

const isLoopback = (ip: string): boolean => ip === '::1' || ip.startsWith('127.') || ip === '::ffff:127.0.0.1';
function forbiddenAddress(ip: string): boolean {
  if (ip.startsWith('169.254.') || ip.toLowerCase().startsWith('fe80:') || ip === '0.0.0.0' || ip === '::') return true;
  if (ip.toLowerCase() === 'fd00:ec2::254') return true;
  return false;
}

async function idpFetch(url: string, init: { method?: string; body?: string; headers?: Record<string, string> }, o: OidcOptions): Promise<unknown> {
  let u: URL;
  try { u = new URL(url); } catch { throw new OidcError('The identity provider URL is not valid.'); }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map(a => a.address);
  if (!addrs.length) throw new OidcError(`Cannot resolve the identity provider host ${host}.`);
  if (addrs.some(forbiddenAddress)) throw new OidcError('The identity provider address is not allowed (link-local or metadata).');
  const loop = addrs.every(isLoopback);
  if (u.protocol !== 'https:' && !(o.allowInsecureIdp && u.protocol === 'http:' && loop)) throw new OidcError('The identity provider must be https.');
  if (loop && !o.allowInsecureIdp) throw new OidcError('A loopback identity provider is only allowed with --allow-insecure-idp.');
  const res = await fetch(u, { method: init.method ?? 'GET', body: init.body, headers: init.headers, redirect: 'manual', signal: AbortSignal.timeout(10_000) });
  if (res.status >= 300 && res.status < 400) throw new OidcError('The identity provider redirected; refusing to follow.');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 1_000_000) throw new OidcError('The identity provider response is too large.');
  let parsed: unknown;
  try { parsed = JSON.parse(buf.toString('utf8')); } catch { parsed = undefined; }
  if (!res.ok) {
    const err = (parsed as { error?: string; error_description?: string } | undefined) ?? {};
    throw new OidcError(`The identity provider refused the request (${res.status}${err.error ? `: ${err.error}` : ''}).`, 'idp-refused');
  }
  if (parsed === undefined) throw new OidcError('The identity provider did not return JSON.');
  return parsed;
}

// ── discovery and keys (cached) ─────────────────────────────────────

const discoveryCache = new Map<string, { at: number; value: Discovery }>();
const jwksCache = new Map<string, { at: number; keys: Jwk[] }>();

export async function discover(issuer: string, o: OidcOptions): Promise<Discovery> {
  const now = (o.now ?? Date.now)();
  const hit = discoveryCache.get(issuer);
  if (hit && now - hit.at < 600_000) return hit.value;
  const doc = await idpFetch(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`, {}, o) as Partial<Discovery>;
  if (doc.issuer !== issuer && doc.issuer !== issuer.replace(/\/$/, '')) throw new OidcError('The discovery document names a different issuer.');
  if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) throw new OidcError('The discovery document is incomplete.');
  const value = doc as Discovery;
  discoveryCache.set(issuer, { at: now, value });
  return value;
}

async function keysFor(d: Discovery, o: OidcOptions, force: boolean): Promise<Jwk[]> {
  const now = (o.now ?? Date.now)();
  const hit = jwksCache.get(d.jwks_uri);
  if (hit && !force && now - hit.at < 600_000) return hit.keys;
  if (hit && force && now - hit.at < 30_000) return hit.keys; // do not let a bad token make us hammer the IdP
  const doc = await idpFetch(d.jwks_uri, {}, o) as { keys?: Jwk[] };
  const keys = Array.isArray(doc.keys) ? doc.keys : [];
  jwksCache.set(d.jwks_uri, { at: now, keys });
  return keys;
}

export function resetOidcCaches(): void { discoveryCache.clear(); jwksCache.clear(); }

// ── the authorization request ───────────────────────────────────────

export interface FlowStart { url: string; state: string; verifier: string; nonce: string }

export async function startFlow(idp: IdpConfig, redirectUri: string, o: OidcOptions, hint?: string): Promise<FlowStart> {
  const d = await discover(idp.issuer, o);
  const state = randomToken(24);
  const verifier = randomToken(48);
  const nonce = randomToken(24);
  const u = new URL(d.authorization_endpoint);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', idp.clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('scope', idp.scopes || 'openid email profile');
  u.searchParams.set('state', state);
  u.searchParams.set('nonce', nonce);
  u.searchParams.set('code_challenge', pkceChallenge(verifier));
  u.searchParams.set('code_challenge_method', 'S256');
  if (hint) u.searchParams.set('login_hint', hint.slice(0, 200));
  return { url: u.toString(), state, verifier, nonce };
}

// ── the code exchange and ID token check ────────────────────────────

export interface IdentityClaims { sub: string; email: string; name: string }

export async function completeFlow(idp: IdpConfig, redirectUri: string, code: string, verifier: string, nonce: string, o: OidcOptions): Promise<IdentityClaims> {
  const d = await discover(idp.issuer, o);
  const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: idp.clientId, code_verifier: verifier });
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  if (idp.clientSecret) headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(idp.clientId)}:${encodeURIComponent(idp.clientSecret)}`).toString('base64')}`;
  const tokens = await idpFetch(d.token_endpoint, { method: 'POST', body: form.toString(), headers }, o) as { id_token?: string };
  if (!tokens.id_token) throw new OidcError('The identity provider returned no ID token.');
  return verifyIdToken(tokens.id_token, idp, d, nonce, o);
}

const ALGS: Record<string, { hash: string; kty: string }> = { RS256: { hash: 'sha256', kty: 'RSA' }, ES256: { hash: 'sha256', kty: 'EC' } };

export async function verifyIdToken(token: string, idp: IdpConfig, d: Discovery, nonce: string, o: OidcOptions): Promise<IdentityClaims> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new OidcError('The ID token is malformed.');
  const [h, p, s] = parts as [string, string, string];
  let head: { alg?: string; kid?: string };
  let claims: Record<string, unknown>;
  try {
    head = JSON.parse(Buffer.from(h, 'base64url').toString('utf8')) as { alg?: string; kid?: string };
    claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch { throw new OidcError('The ID token is malformed.'); }
  const alg = ALGS[head.alg ?? ''];
  if (!alg) throw new OidcError(`The ID token algorithm ${JSON.stringify(head.alg)} is not accepted (RS256 or ES256 only).`);

  let jwk = (await keysFor(d, o, false)).find(k => (!head.kid || k.kid === head.kid) && k.kty === alg.kty && (!k.use || k.use === 'sig'));
  if (!jwk) jwk = (await keysFor(d, o, true)).find(k => (!head.kid || k.kid === head.kid) && k.kty === alg.kty && (!k.use || k.use === 'sig'));
  if (!jwk) throw new OidcError('No key matches the ID token.');
  let ok = false;
  try {
    const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    ok = crypto.verify(alg.hash, Buffer.from(`${h}.${p}`), alg.kty === 'EC' ? { key, dsaEncoding: 'ieee-p1363' } : key, Buffer.from(s, 'base64url'));
  } catch { ok = false; }
  if (!ok) throw new OidcError('The ID token signature is not valid.');

  const nowSec = Math.floor((o.now ?? Date.now)() / 1000);
  const iss = String(claims.iss ?? '');
  if (iss !== idp.issuer && iss !== idp.issuer.replace(/\/$/, '')) throw new OidcError('The ID token issuer is not the configured one.');
  const aud = Array.isArray(claims.aud) ? claims.aud.map(String) : [String(claims.aud ?? '')];
  if (!aud.includes(idp.clientId)) throw new OidcError('The ID token is not for this client.');
  if (aud.length > 1 && claims.azp !== idp.clientId) throw new OidcError('The ID token authorized party is not this client.');
  if (typeof claims.exp !== 'number' || claims.exp + 60 <= nowSec) throw new OidcError('The ID token has expired.');
  if (typeof claims.iat === 'number' && claims.iat - 60 > nowSec) throw new OidcError('The ID token was issued in the future.');
  if (claims.nonce !== nonce) throw new OidcError('The ID token nonce does not match this sign-in.');
  const sub = typeof claims.sub === 'string' ? claims.sub : '';
  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
  if (!sub) throw new OidcError('The ID token has no subject.');
  if (!email || !email.includes('@')) throw new OidcError('The ID token has no email address; request the "email" scope.');
  if (claims.email_verified === false) throw new OidcError('The identity provider says this email address is not verified.');
  const name = typeof claims.name === 'string' ? claims.name.slice(0, 200) : '';
  return { sub, email, name };
}
