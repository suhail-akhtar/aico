/**
 * SSH host keys AICO has been told to trust, in OpenSSH `known_hosts` format.
 *
 * Host-key verification is what makes an SSH password safe to send: without
 * it, whoever answers on 10.0.0.5:22 — a spoofed ARP entry, a compromised
 * router — receives the owner's root password. The easy way out every SSH
 * wrapper reaches for, `StrictHostKeyChecking=no`, is exactly that hole, so
 * it does not exist here:
 *
 *  - a **known** key must match, or the connection is refused before any
 *    credential is resolved — no prompt offers "trust the new key anyway";
 *    changing a pinned key is a person editing this file;
 *  - an **unknown** host is trust-on-first-use, but the "use" is a person's:
 *    the credential is resolved with `requireApproval`, and the approval text
 *    names the key type and SHA256 fingerprint. Only after that yes, and a
 *    connection that presents the same key, is the line written.
 *
 * The file lives at `<AICO_HOME>/ops/known_hosts`, mode 0600, written
 * atomically. OpenSSH format rather than JSON so a person can seed it from
 * their own `~/.ssh/known_hosts` (hashed `|1|` entries included) and read it
 * with the tools they already have. AICO never reads `~/.ssh` itself: the
 * owner's own trust store is theirs.
 *
 * @module tools/ops/known-hosts
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { aicoHome } from '../../home.js';

export interface KnownHostEntry {
  /** Host patterns as written: `host`, `[host]:port`, comma-separated, or `|1|salt|hash`. */
  hosts: string;
  keyType: string;
  /** Base64 of the public key blob. */
  key: string;
  marker?: '@revoked' | '@cert-authority';
}

export type HostKeyCheck =
  | { status: 'match'; keyType: string; fingerprint: string }
  | { status: 'unknown'; keyType: string; fingerprint: string }
  | { status: 'mismatch'; keyType: string; fingerprint: string; expected: string[] }
  | { status: 'revoked'; keyType: string; fingerprint: string };

/** Where AICO's own known_hosts lives. Resolved at call time so AICO_HOME can move in tests. */
export function knownHostsPath(): string {
  return path.join(aicoHome(), 'ops', 'known_hosts');
}

/** `SHA256:…` fingerprint of a public key blob, as `ssh-keygen -l` prints it. */
export function fingerprintOf(blob: Buffer): string {
  return `SHA256:${crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
}

/** The key type named inside an SSH public key blob (its first string). */
export function keyTypeOf(blob: Buffer): string {
  if (blob.length < 4) return 'unknown';
  const len = blob.readUInt32BE(0);
  if (len <= 0 || len > 64 || blob.length < 4 + len) return 'unknown';
  return blob.subarray(4, 4 + len).toString('ascii');
}

/** How a host and port are written in known_hosts: bare for 22, `[host]:port` otherwise. */
export function hostToken(host: string, port: number): string {
  const h = host.toLowerCase();
  return port === 22 ? h : `[${h}]:${port}`;
}

/** Parse known_hosts text. Comments, blank lines and malformed lines are skipped. */
export function parseKnownHosts(text: string): KnownHostEntry[] {
  const out: KnownHostEntry[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    let marker: KnownHostEntry['marker'];
    if (parts[0] === '@revoked' || parts[0] === '@cert-authority') marker = parts.shift() as KnownHostEntry['marker'];
    const [hosts, keyType, key] = parts;
    if (!hosts || !keyType || !key || !/^[A-Za-z0-9+/]+={0,2}$/.test(key)) continue;
    out.push({ hosts, keyType, key, ...(marker ? { marker } : {}) });
  }
  return out;
}

/** Does one host pattern (from a comma list) name this host token? Handles `|1|` hashes and `*`/`?` globs. */
function patternMatches(pattern: string, token: string): boolean {
  if (pattern.startsWith('|1|')) {
    const [, , salt, hash] = pattern.split('|');
    if (!salt || !hash) return false;
    const mac = crypto.createHmac('sha1', Buffer.from(salt, 'base64')).update(token).digest('base64');
    return mac === hash;
  }
  const negated = pattern.startsWith('!');
  const p = (negated ? pattern.slice(1) : pattern).toLowerCase();
  // OpenSSH patterns know only `*` and `?`; everything else is literal —
  // including the brackets of `[host]:port`, which a regex would read as a class.
  const re = new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
  return re.test(token);
}

function entryNames(entry: KnownHostEntry, token: string): boolean {
  const patterns = entry.hosts.split(',');
  if (patterns.some(p => p.startsWith('!') && patternMatches(p, token))) return false;
  return patterns.some(p => !p.startsWith('!') && patternMatches(p, token));
}

/**
 * Check a presented key against the entries for `host:port`. Pure.
 *
 * `@cert-authority` lines are ignored (AICO does not do host certificates),
 * so a host known only through a CA is treated as unknown rather than trusted.
 */
export function checkHostKey(entries: KnownHostEntry[], host: string, port: number, blob: Buffer): HostKeyCheck {
  const token = hostToken(host, port);
  const presented = blob.toString('base64');
  const keyType = keyTypeOf(blob);
  const fingerprint = fingerprintOf(blob);
  const mine = entries.filter(e => entryNames(e, token));
  if (mine.some(e => e.marker === '@revoked' && e.key === presented)) return { status: 'revoked', keyType, fingerprint };
  const plain = mine.filter(e => !e.marker);
  if (plain.some(e => e.key === presented)) return { status: 'match', keyType, fingerprint };
  if (plain.length) {
    return {
      status: 'mismatch', keyType, fingerprint,
      expected: plain.map(e => `${e.keyType} ${fingerprintOf(Buffer.from(e.key, 'base64'))}`),
    };
  }
  return { status: 'unknown', keyType, fingerprint };
}

/** Whether any plain entry names this host:port — decides if a probe connection is needed first. */
export function hasEntryFor(entries: KnownHostEntry[], host: string, port: number): boolean {
  const token = hostToken(host, port);
  return entries.some(e => !e.marker && entryNames(e, token));
}

/** One known_hosts line for a newly trusted key. */
export function formatEntry(host: string, port: number, blob: Buffer, comment?: string): string {
  const safeComment = comment ? ` ${comment.replace(/[^\w.@:+-]/g, '_').slice(0, 80)}` : '';
  return `${hostToken(host, port)} ${keyTypeOf(blob)} ${blob.toString('base64')}${safeComment}`;
}

// ── the file ─────────────────────────────────────────────────────────

export function readKnownHosts(file = knownHostsPath()): KnownHostEntry[] {
  try { return parseKnownHosts(fs.readFileSync(file, 'utf8')); } catch { return []; }
}

/**
 * Append a trusted key. Atomic (temp file + rename) and 0600, and refuses to
 * add a second key for a host that already has one — replacing a pinned key
 * is the owner's decision, made by editing the file.
 */
export function trustHostKey(host: string, port: number, blob: Buffer, comment?: string, file = knownHostsPath()): void {
  const existing = (() => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } })();
  const entries = parseKnownHosts(existing);
  const check = checkHostKey(entries, host, port, blob);
  if (check.status === 'match') return;
  if (check.status !== 'unknown') {
    throw new Error(`Refusing to change the pinned host key for ${hostToken(host, port)}; edit ${file} by hand if the change is expected.`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const body = `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}${formatEntry(host, port, blob, comment)}\n`;
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* Windows ignores POSIX modes; the file is under the user's profile */ }
}
