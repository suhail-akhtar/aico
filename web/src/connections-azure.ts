/**
 * Azure DevOps' share of the Connections page logic: how a person's words become an
 * organization, a project/repository pair and a process-aware state preview. Pure, no DOM.
 *
 * WHY separate from `connections.ts`. The generic file is the same for every provider and
 * is edited by every adapter; what is specific to Azure DevOps is small but has real rules the
 * generic code would only blur: an organization is part of the ADDRESS (so the page asks for a
 * name, not a URL, unless the person runs a Server), a project name may hold spaces, and its
 * work item states are not labels but categories that mean different words in each process
 * (Active, Committed, Doing). The engine re-validates every one of these (`urls.ts`, `wiql.ts`);
 * this file only keeps the page from offering what would be refused and previews the outcome
 * with the very function the engine writes with (`shared/connections/process.ts`).
 *
 * What it does not do: fetch, render, or decide policy.
 *
 * @module web/connections-azure
 */

import { previewStateMap, type StatePreviewRow, type TypeStates } from '../../shared/connections/process';

const ORG = /^[A-Za-z0-9][A-Za-z0-9-]{0,49}$/;

export type OrgCheck = { ok: true; org: string; baseUrl: string } | { ok: false; error: string };

/**
 * An Azure DevOps Services organization from whatever was typed: `acme`, `dev.azure.com/acme`,
 * `https://dev.azure.com/acme/Shop`, or the legacy `https://acme.visualstudio.com`.
 */
export function parseAzureOrg(raw: string): OrgCheck {
  const text = raw.trim();
  if (!text) return { ok: false, error: 'Enter your organization name, for example acme (from dev.azure.com/acme).' };
  let org = text;
  if (/[/.:]/.test(text)) {
    let u: URL;
    try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`); } catch { return { ok: false, error: 'That is not an organization name or an Azure DevOps address.' }; }
    const host = u.hostname.toLowerCase();
    if (host === 'dev.azure.com') org = u.pathname.split('/').filter(Boolean)[0] ?? '';
    else {
      const legacy = /^([a-z0-9][a-z0-9-]*)\.visualstudio\.com$/.exec(host);
      if (!legacy) return { ok: false, error: 'That address is not dev.azure.com or an .visualstudio.com organization. For a server your company runs, tick the box above.' };
      org = legacy[1]!;
    }
  }
  if (!ORG.test(org)) return { ok: false, error: 'An organization name uses letters, digits and hyphens, and starts with a letter or digit.' };
  return { ok: true, org, baseUrl: `https://dev.azure.com/${org}` };
}

/** The organization in a Services address, for labels ("Azure DevOps (acme)"); undefined for any other address. */
export function orgOfBaseUrl(baseUrl: string): string | undefined {
  try {
    const u = new URL(baseUrl);
    return u.hostname.toLowerCase() === 'dev.azure.com' ? u.pathname.split('/').filter(Boolean)[0] : undefined;
  } catch { return undefined; }
}

// eslint-disable-next-line no-control-regex
const BAD_NAME = /[\\/<>*?|:"\u0000-\u001f\u007f]/;

/**
 * `Project/Repository` (spaces allowed), or a pasted clone/web address
 * (`https://dev.azure.com/acme/Shop/_git/web`, `git@ssh.dev.azure.com:v3/acme/Shop/web`).
 */
export function parseAzureRepo(text: string): { owner: string; name: string } | null {
  const t = text.trim();
  const dec = (x: string): string => { try { return decodeURIComponent(x); } catch { return x; } };
  let owner = ''; let name = '';
  if (/^https?:\/\//i.test(t)) {
    let u: URL | undefined;
    try { u = new URL(t); } catch { return null; }
    const segs = u.pathname.split('/').filter(Boolean).map(dec);
    const i = segs.indexOf('_git');
    if (i < 0 || !segs[i + 1]) return null;
    name = segs[i + 1]!;
    // dev.azure.com/<org>/_git/<repo>: the project is named like the repository; otherwise the segment before `_git` is the project.
    owner = i >= 1 && !(u.hostname.toLowerCase() === 'dev.azure.com' && i === 1) ? segs[i - 1]! : name;
  } else {
    const ssh = /:v3\/[^/]+\/([^/]+)\/([^/]+)$/.exec(t);
    if (ssh) { owner = dec(ssh[1]!); name = dec(ssh[2]!); }
    else {
      const parts = t.split('/').map(x => x.trim());
      if (parts.length !== 2) return null;
      [owner, name] = parts as [string, string];
    }
  }
  name = name.replace(/\.git$/i, '');
  if (!owner || !name || BAD_NAME.test(owner) || BAD_NAME.test(name) || owner.length > 128 || name.length > 128 || /\.$/.test(owner) || /\.$/.test(name) || owner === '..' || name === '..') return null;
  return { owner, name };
}

/** Work-item source wording for Azure DevOps: tags and WIQL, not labels and search text. */
export const AZURE_SOURCE_WORDS: Record<string, { label?: string; hint?: string; valueLabel?: string; placeholder?: string }> = {
  label: { label: 'Tag', hint: 'Open work items that carry this tag.', valueLabel: 'Tag', placeholder: 'aico' },
  query: {
    hint: 'Open work items matching a WIQL condition: what follows WHERE. Epics, Features and test items are never imported.',
    valueLabel: 'WIQL condition', placeholder: "[System.AreaPath] UNDER 'Shop\\Web'",
  },
};

/** The process the project's work item types point to, as the engine's `connections/discover?kind=process` answers. */
export interface ProcessInfo { name: string; types: TypeStates[]; pointsField?: string }

/** The page's preview: each AICO state, the category it maps to, and the state each work item type would be moved to. */
export function azureStatePreview(stateMap: Readonly<Record<string, string>>, process: ProcessInfo | null | undefined, rows: readonly string[]): StatePreviewRow[] {
  return previewStateMap(stateMap, process?.types ?? [], rows);
}

/** "Agile" -> "Agile process: User Story, Bug and Task". At most four types are named. */
export function processSummary(p: ProcessInfo): string {
  const names = p.types.map(t => t.name);
  const shown = names.slice(0, 4);
  const list = shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}` : shown.join('');
  return `${p.name === 'Custom' ? 'A customised' : `The ${p.name}`} process${list ? `: ${list}${names.length > shown.length ? ` and ${names.length - shown.length} more` : ''}` : ''}.`;
}
