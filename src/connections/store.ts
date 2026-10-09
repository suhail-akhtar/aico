/**
 * Where connections and project mappings live, and nothing else.
 *
 * WHERE. `aicoHome()/connections/connections.json` for the connections (the user store)
 * and `aicoHome()/delivery/<project key>/connection.json` for a project's mapping, beside
 * its Delivery journal. Never in the repository: a cloned repo must not be able to point
 * the engine at a host of its choosing (the project-trust lesson of ADR 0009), so the
 * repository can only SUGGEST a remote (its `origin`), and only a person creates the
 * connection.
 *
 * WHAT. Plain JSON, written atomically (temp file + rename) with mode 0600. Neither file
 * contains a secret: a connection holds the vault NAME of its credential, never a value.
 * They are configuration rather than history, so unlike the Delivery journal they are
 * replaced in place; every change is an audit event (audit.ts) instead.
 *
 * What this module does not do: decide whether a change is allowed (service.ts and the
 * managed policy do), or talk to the network.
 *
 * @module connections/store
 */

import fs from 'node:fs';
import path from 'node:path';
import { aicoHome } from '../home.js';
import { projectKey } from '../learning/proposals.js';
import { CONNECTION_ID_RE, type ProjectMapping, type StoredConnection } from './types.js';

export function connectionsDir(): string { return path.join(aicoHome(), 'connections'); }
export function connectionsFile(): string { return path.join(connectionsDir(), 'connections.json'); }
export function mappingFile(project: string): string {
  return path.join(aicoHome(), 'delivery', projectKey(project), 'connection.json');
}

function writeAtomic(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return fallback; }
}

// ── connections ──────────────────────────────────────────────────────────

interface ConnectionsDoc { version: 1; connections: StoredConnection[] }

export function listConnections(): StoredConnection[] {
  const doc = readJson<Partial<ConnectionsDoc>>(connectionsFile(), {});
  return Array.isArray(doc.connections) ? doc.connections.filter(c => c && typeof c.id === 'string' && CONNECTION_ID_RE.test(c.id)) : [];
}

export function getConnection(id: string): StoredConnection | undefined {
  return listConnections().find(c => c.id === id);
}

export function putConnection(c: StoredConnection): void {
  const all = listConnections().filter(x => x.id !== c.id);
  all.push(c);
  writeAtomic(connectionsFile(), { version: 1, connections: all } satisfies ConnectionsDoc);
}

export function removeConnection(id: string): void {
  writeAtomic(connectionsFile(), { version: 1, connections: listConnections().filter(c => c.id !== id) } satisfies ConnectionsDoc);
}

/** `github-com`, `acme-ghe`: a readable slug that is unique among the stored ids. */
export function newConnectionId(provider: string, host: string): string {
  const base = `${provider}-${host}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'connection';
  const taken = new Set(listConnections().map(c => c.id));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
  return `${base}-${Date.now()}`;
}

// ── project mappings ─────────────────────────────────────────────────────

export function getMapping(project: string): ProjectMapping | undefined {
  const m = readJson<ProjectMapping | undefined>(mappingFile(path.resolve(project)), undefined);
  return m && typeof m === 'object' && typeof m.connection === 'string' && m.repo ? m : undefined;
}

export function putMapping(m: ProjectMapping): void {
  writeAtomic(mappingFile(path.resolve(m.project)), { ...m, project: path.resolve(m.project) });
}

export function removeMapping(project: string): void {
  try { fs.rmSync(mappingFile(path.resolve(project)), { force: true }); } catch { /* already gone */ }
}

/** Every stored mapping (a scan of the delivery folders; there are few). */
export function allMappings(): ProjectMapping[] {
  const root = path.join(aicoHome(), 'delivery');
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(root); } catch { return []; }
  const out: ProjectMapping[] = [];
  for (const d of dirs) {
    const m = readJson<ProjectMapping | undefined>(path.join(root, d, 'connection.json'), undefined);
    if (m && typeof m.project === 'string' && typeof m.connection === 'string' && m.repo) out.push(m);
  }
  return out;
}

export function mappingsOf(connectionId: string): ProjectMapping[] {
  return allMappings().filter(m => m.connection === connectionId);
}
