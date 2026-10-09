/**
 * Where Azure DevOps lives, in all the shapes a person pastes: Services (`dev.azure.com/<org>`),
 * the legacy `<org>.visualstudio.com`, and Server (an on-premises collection such as
 * `https://tfs.corp/tfs/DefaultCollection`). Pure string work, no network.
 *
 * WHY its own file. The same repository has half a dozen spellings (https with and without the
 * `<org>@` user-info Azure itself puts in clone URLs, the short `/_git/<repo>` form, `ssh.dev.azure.com`
 * `v3/` paths, the legacy host, a Server collection with or without `/tfs`) and the project in
 * them can contain spaces and be percent-encoded. Getting "which repository is this origin" right is
 * what makes the page say "Connect Azure DevOps for this repo?" at the right moments and never at
 * the wrong ones, so the rules are a table in a test, not logic spread through the adapter.
 *
 * The mapping to AICO's `RepoRef` is: `owner` = the Azure DevOps PROJECT, `name` = the Git repository.
 * The organization (or collection) belongs to the connection's base URL, not to the repository.
 *
 * What it does not do: decide anything about tokens or versions, or call the service.
 *
 * @module connections/azure-devops/urls
 */

import type { RepoRef } from '../../../shared/connections/types.js';

export type AzureKind = 'services' | 'legacy' | 'server';

export interface AzureBase {
  kind: AzureKind;
  /** `https://dev.azure.com/acme` | `https://acme.visualstudio.com` | `https://tfs.corp/tfs/DefaultCollection`: the root every API path hangs from. */
  apiBase: string;
  /** `scheme://host[:port]`. */
  origin: string;
  host: string;
  hostname: string;
  /** The organization, for Services and the legacy host. */
  org?: string;
  /** The path of the collection on a Server, no trailing slash ('' for the root). */
  path: string;
}

const ORG = /^[A-Za-z0-9][A-Za-z0-9-]{0,49}$/;

/** Undefined when `baseUrl` is not a URL, or is Services without an organization. */
export function parseBase(baseUrl: string): AzureBase | undefined {
  let u: URL;
  try { u = new URL(baseUrl.trim()); } catch { return undefined; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined;
  const host = u.host.toLowerCase();
  const hostname = u.hostname.toLowerCase();
  const segs = u.pathname.split('/').filter(Boolean).map(decode);
  if (hostname === 'dev.azure.com') {
    const org = segs[0];
    if (!org || !ORG.test(org)) return undefined;
    return { kind: 'services', apiBase: `https://dev.azure.com/${org}`, origin: 'https://dev.azure.com', host, hostname, org, path: `/${org}` };
  }
  const legacy = /^([a-z0-9][a-z0-9-]{0,49})\.visualstudio\.com$/.exec(hostname);
  if (legacy && !hostname.startsWith('vs-ssh.')) {
    return { kind: 'legacy', apiBase: `https://${hostname}`, origin: `https://${hostname}`, host, hostname, org: legacy[1]!, path: '' };
  }
  const path = u.pathname.replace(/\/+$/, '');
  return { kind: 'server', apiBase: `${u.origin}${path}`, origin: u.origin, host, hostname, path };
}

export function hostsFor(baseUrl: string): string[] {
  const b = parseBase(baseUrl);
  return b ? [b.host] : [];
}

function decode(s: string): string { try { return decodeURIComponent(s); } catch { return s; } }

// ── repository names ─────────────────────────────────────────────────────

/** Why a project or repository name cannot be used, or undefined. Azure DevOps names may hold spaces and non-ASCII letters. */
export function nameProblem(name: string, what: 'project' | 'repository'): string | undefined {
  if (!name || name !== name.trim()) return `The ${what} name is empty or has spaces at its ends.`;
  if (name.length > 128) return `The ${what} name is longer than 128 characters.`;
  if (name === '.' || name === '..' || /\.$/.test(name)) return `"${name.slice(0, 40)}" is not a usable ${what} name.`;
  // eslint-disable-next-line no-control-regex
  if (/[\\/<>*?|:"\u0000-\u001f\u007f]/.test(name)) return `The ${what} name "${name.slice(0, 40)}" has a character Azure DevOps does not allow.`;
  return undefined;
}

export function validateRepo(ref: RepoRef): string | undefined {
  return nameProblem(ref.owner, 'project') ?? nameProblem(ref.name, 'repository');
}

// ── remotes ──────────────────────────────────────────────────────────────

const sameOrg = (a: string | undefined, b: string | undefined): boolean => Boolean(a && b && a.toLowerCase() === b.toLowerCase());

function repoFrom(segs: string[]): RepoRef | undefined {
  // [..., project, '_git', repo]  or the short form [..., '_git', repo] where the project is named like the repository.
  const i = segs.indexOf('_git');
  if (i < 0 || i !== segs.length - 2) return undefined;
  const name = segs[i + 1]!.replace(/\.git$/i, '');
  const project = i >= 1 ? segs[i - 1]! : name;
  const ref: RepoRef = { owner: project, name };
  return validateRepo(ref) ? undefined : ref;
}

/** The organization in `https://dev.azure.com/<org>/...` or `<org>.visualstudio.com`, from any Azure DevOps Services remote. */
function servicesRemote(t: string): { org: string; repo: RepoRef } | undefined {
  // scp-like and ssh: git@ssh.dev.azure.com:v3/<org>/<project>/<repo>, <org>@vs-ssh.visualstudio.com:v3/<org>/<project>/<repo>
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/.exec(t);
  let host: string | undefined;
  let segs: string[] | undefined;
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) { host = scp[1]!.toLowerCase(); segs = scp[2]!.split('/').filter(Boolean).map(decode); }
  else {
    let u: URL;
    try { u = new URL(t); } catch { return undefined; }
    if (!['https:', 'http:', 'ssh:'].includes(u.protocol)) return undefined;
    host = u.hostname.toLowerCase();
    segs = u.pathname.split('/').filter(Boolean).map(decode);
  }
  if (host === 'ssh.dev.azure.com' || host === 'vs-ssh.visualstudio.com') {
    if (segs[0] !== 'v3' || segs.length !== 4) return undefined;
    const ref = { owner: segs[2]!, name: segs[3]!.replace(/\.git$/i, '') };
    return validateRepo(ref) || !ORG.test(segs[1]!) ? undefined : { org: segs[1]!, repo: ref };
  }
  if (host === 'dev.azure.com') {
    const org = segs[0];
    const repo = repoFrom(segs.slice(1));
    return org && ORG.test(org) && repo ? { org, repo } : undefined;
  }
  const m = /^([a-z0-9][a-z0-9-]{0,49})\.visualstudio\.com$/.exec(host);
  if (m) {
    const rest = segs[0]?.toLowerCase() === 'defaultcollection' ? segs.slice(1) : segs;
    const repo = repoFrom(rest);
    return repo ? { org: m[1]!, repo } : undefined;
  }
  return undefined;
}

/** `origin` as a repository on this connection, or undefined if it is another organization, another server, or not Azure DevOps. */
export function parseRemote(url: string, baseUrl: string): RepoRef | undefined {
  const base = parseBase(baseUrl);
  if (!base) return undefined;
  const t = url.trim();
  if (!t) return undefined;
  if (base.kind !== 'server') {
    const s = servicesRemote(t);
    return s && sameOrg(s.org, base.org) ? s.repo : undefined;
  }
  // Server: https://host[:port]/<collection path>/<project>/_git/<repo>, or ssh://host[:port]/<collection path>/...
  let u: URL;
  try { u = new URL(t); } catch { return undefined; }
  if (!['https:', 'http:', 'ssh:'].includes(u.protocol)) return undefined;
  const web = u.protocol !== 'ssh:';
  const sameHost = web ? u.host.toLowerCase() === base.host : u.hostname.toLowerCase() === base.hostname;
  if (!sameHost) return undefined;
  const segs = u.pathname.split('/').filter(Boolean).map(decode);
  const prefix = base.path.split('/').filter(Boolean).map(decode);
  // A collection the person wrote as ".../tfs/DefaultCollection" may be cloned as ".../DefaultCollection" over ssh.
  const startsWith = (p: string[]): boolean => p.every((s, i) => segs[i]?.toLowerCase() === s.toLowerCase());
  const drop = startsWith(prefix) ? prefix.length : prefix.length > 1 && startsWith(prefix.slice(1)) ? prefix.length - 1 : -1;
  if (drop < 0) return undefined;
  return repoFrom(segs.slice(drop));
}

/** A remote of Azure DevOps Services (any spelling) as a base URL and repository, for the "Connect it?" line. */
export function suggestFromRemote(origin: string): { baseUrl: string; repo: RepoRef } | undefined {
  const s = servicesRemote(origin.trim());
  return s ? { baseUrl: `https://dev.azure.com/${s.org}`, repo: s.repo } : undefined;
}

// ── web and clone URLs (rebuilt from the base, never copied from a response) ──

const enc = encodeURIComponent;

export function cloneUrl(base: AzureBase, ref: RepoRef): string {
  return `${base.apiBase}/${enc(ref.owner)}/_git/${enc(ref.name)}`;
}
export function pullWebUrl(base: AzureBase, ref: RepoRef, id: string | number): string {
  return `${cloneUrl(base, ref)}/pullrequest/${id}`;
}
export function itemWebUrl(base: AzureBase, project: string, id: string | number): string {
  return `${base.apiBase}/${enc(project)}/_workitems/edit/${id}`;
}
export function buildWebUrl(base: AzureBase, project: string, buildId: string | number): string {
  return `${base.apiBase}/${enc(project)}/_build/results?buildId=${buildId}`;
}
