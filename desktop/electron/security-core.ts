/**
 * The desktop's main-process guards, as plain functions of plain data.
 *
 * WHY. A security review (2026-10) found that several decisions in main were
 * made inline, next to Electron calls, where no test could reach them: which
 * URLs the agent may open in the built-in browser (it could open `file:`,
 * `view-source:`, `chrome:`), which IPC senders may call the app's handlers
 * (any frame that reached the preload), which paths the renderer may read or
 * write, which files the agent may upload to a site, whether browser_evaluate
 * may run on a checkout page, and whether the OS keychain can protect saved
 * autofill data. Each verdict now lives here and is unit-tested
 * (scripts/test-security.mjs); the Electron modules collect the facts and ask.
 *
 * Every function here only narrows: it says "refuse" or "needs a person",
 * never "allowed despite" (AGENTS.md §4.7). It imports nothing from Electron,
 * and nothing from the engine (architecture.md).
 *
 * What it deliberately does not do: read the page, the disk or the prefs.
 * The callers do that and pass the facts in.
 *
 * @module desktop/electron/security-core
 */

import crypto from 'node:crypto';
import path from 'node:path';

// ── Addresses ────────────────────────────────────────────────────────────────

/**
 * What the address bar (or the agent) typed, as a URL to load: a scheme kept,
 * a bare host made https, anything else a search. Unchanged from the
 * browser's earlier inline rule; what the AGENT may open is narrowed below.
 */
export function normaliseAddress(u: string): string {
  const s = u.trim();
  if (/^(https?|file|about|data):/i.test(s) || /^view-source:https?:/i.test(s)) return s;
  if (/^localhost(:\d+)?(\/|$)|^127\.0\.0\.1|^\[::1\]/.test(s)) return `http://${s}`;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(s)) return `https://${s}`;
  return `https://duckduckgo.com/?q=${encodeURIComponent(s)}`;
}

/**
 * May the agent load this (already normalised) URL? Only web pages and the
 * empty page. `file:` would read the person's disk into the model, `data:` and
 * `view-source:` dress up arbitrary content as a page, and `chrome:` /
 * `devtools:` reach browser internals. The person may still type a `file:`
 * address themselves. Returns the refusal, or null.
 */
export function agentOpenRefusal(url: string): string | null {
  if (agentNavigationAllowed(url)) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url.trim())?.[1]?.toLowerCase() ?? '';
  return `Refused: the agent may open only http(s) web pages (and about:blank), not ${scheme ? `${scheme}: addresses` : 'that address'}. `
    + 'To read a local file use the file tools; if the user wants this page open, they can type it in the address bar.';
}

/** A navigation an agent-driven tab may make: http(s), about:blank, and blob: of a web page. */
export function agentNavigationAllowed(url: string): boolean {
  const s = url.trim();
  if (/^about:blank(?:[?#].*)?$/i.test(s)) return true;
  if (/^blob:https?:\/\//i.test(s)) return true;
  try {
    const u = new URL(s);
    return (u.protocol === 'http:' || u.protocol === 'https:') && Boolean(u.hostname);
  } catch { return false; }
}

/**
 * May this URL be handed to the operating system (shell.openExternal)? Only
 * http(s) with a host, and mailto:. The OS resolves every other scheme to a
 * handler: `file:` and `smb:`/UNC paths run or fetch local and remote files,
 * `ms-msdt:`, `search-ms:`, `ms-settings:` and app protocols (`vscode:`, …)
 * launch programs with page-chosen arguments — so a link a page controls
 * (context menu, window.open, a navigation) must never reach them. The input
 * is not trimmed: a URL with leading junk is refused, not repaired.
 */
export function externalLinkAllowed(url: string): boolean {
  if (typeof url !== 'string' || !/^(https?|mailto):/i.test(url)) return false;
  try {
    const u = new URL(url);
    if (u.protocol === 'mailto:') return true;
    return (u.protocol === 'http:' || u.protocol === 'https:') && Boolean(u.hostname);
  } catch { return false; }
}

// ── Paths ────────────────────────────────────────────────────────────────────

/** Paths on Windows compare without case; elsewhere case matters. */
function key(p: string, platform: NodeJS.Platform): string {
  const r = (platform === 'win32' ? path.win32 : path.posix).resolve(p);
  return platform === 'win32' ? r.toLowerCase() : r;
}

/** Is `p` one of `roots` or inside one (after resolving `..`)? */
export function insideAny(p: string, roots: readonly string[], platform: NodeJS.Platform = process.platform): boolean {
  if (!p) return false;
  const sep = platform === 'win32' ? '\\' : '/';
  const target = key(p, platform);
  return roots.some((root) => {
    if (!root) return false;
    const r = key(root, platform);
    return target === r || target.startsWith(r.endsWith(sep) ? r : r + sep);
  });
}

/** Folders that hold keys and tokens, wherever they sit. */
const SECRET_DIRS = new Set(['.ssh', '.aws', '.gnupg', '.kube', '.docker', '.azure', '.gcloud', '.password-store', '.aico']);
/** Files that are keys, key stores or credentials by name. */
const SECRET_FILE = /^(?:id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?(?:\.pub)?|.*\.(?:pem|key|p12|pfx|ppk|kdbx|keystore|jks|asc|gpg)|credentials(?:\.json)?|known_hosts|authorized_keys)$/i;

export type UploadVerdict = { kind: 'refuse'; reason: string } | { kind: 'inside' } | { kind: 'outside' };

/**
 * May the agent attach this file to a web form? Never a dotfile, a key, or
 * anything in AICO's own store (it holds the vault and settings). Files in the
 * person's projects or Downloads are the expected case; anything else is
 * named to the person as outside, and they decide.
 */
export function uploadVerdict(
  file: string,
  where: { roots: readonly string[]; downloads?: string; aicoHome?: string; platform?: NodeJS.Platform },
): UploadVerdict {
  const platform = where.platform ?? process.platform;
  const p = platform === 'win32' ? path.win32 : path.posix;
  const abs = p.resolve(file);
  const base = p.basename(abs);
  if (where.aicoHome && insideAny(abs, [where.aicoHome], platform)) {
    return { kind: 'refuse', reason: `Refused: ${base} is in AICO's own store (settings, vault, memory) and is never uploaded.` };
  }
  const parts = abs.split(/[\\/]+/).filter(Boolean);
  const dir = parts.slice(0, -1).find(s => SECRET_DIRS.has(s.toLowerCase()));
  if (dir) return { kind: 'refuse', reason: `Refused: ${base} is inside ${dir}, a folder of keys or credentials, and is never uploaded by the agent.` };
  if (base.startsWith('.')) return { kind: 'refuse', reason: `Refused: ${base} is a dotfile (configuration that often holds secrets, like .env or .npmrc) and is never uploaded by the agent.` };
  if (SECRET_FILE.test(base)) return { kind: 'refuse', reason: `Refused: ${base} looks like a key or credential file and is never uploaded by the agent.` };
  const roots = [...where.roots, ...(where.downloads ? [where.downloads] : [])];
  return insideAny(abs, roots, platform) ? { kind: 'inside' } : { kind: 'outside' };
}

/** Files the OS would run rather than show: opening one from the interface asks first. */
export function isExecutablePath(file: string): boolean {
  return /\.(?:exe|com|bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|msi|msp|scr|pif|lnk|cpl|hta|jar|reg|sh|bash|zsh|command|app|appimage|desktop|run|bin|py|pyw|rb|pl)$/i.test(file.trim());
}

// ── IPC senders ──────────────────────────────────────────────────────────────

/**
 * May this frame call the app's IPC handlers? Only the top frame of a page on
 * `aico://app` — the AICO window, the browser's own window, the copilot
 * overlay. A plugin frame, an HTML preview, a web page in the built-in
 * browser, or an iframe inside the app is refused.
 */
export function appFrameAllowed(frame: { url: string; isTopFrame: boolean } | null | undefined): boolean {
  if (!frame || !frame.isTopFrame) return false;
  try {
    const u = new URL(frame.url);
    return u.protocol === 'aico:' && u.host === 'app';
  } catch { return false; }
}

/** The same frame: Electron's frame identity is (process, routing id). */
export function sameFrame(a: { processId: number; routingId: number } | null | undefined, b: { processId: number; routingId: number } | null | undefined): boolean {
  return Boolean(a && b && a.processId === b.processId && a.routingId === b.routingId);
}

// ── Page script (browser_evaluate) ───────────────────────────────────────────

export interface EvaluatePageFacts {
  /** The commit gate's page cue: a checkout / payment page. */
  checkout: boolean;
  /** Card fields (autocomplete cc-number / cc-csc / cc-exp) on the page. */
  cardFields: number;
  /** Password fields that hold a value. */
  filledPasswords: number;
}

/**
 * browser_evaluate runs arbitrary script in the page as the person. Never on
 * a checkout or payment page, and never while a password field holds a value
 * (the script could read it). Elsewhere it still needs the person's Allow.
 */
export function evaluateRefusal(f: EvaluatePageFacts): string | null {
  if (f.checkout || f.cardFields > 0) return 'Refused: this looks like a checkout or payment page. browser_evaluate never runs here — use browser_snapshot / browser_click, which go through the purchase gate.';
  if (f.filledPasswords > 0) return 'Refused: a password field on this page holds a value, and a page script could read it. browser_evaluate does not run here.';
  return null;
}

// ── OS keychain ──────────────────────────────────────────────────────────────

/**
 * Why safeStorage cannot protect data here, or undefined when it can. On
 * Linux without a keyring Electron falls back to a fixed key ("basic_text"),
 * which protects nothing. Shared by the vault key (vault-host.ts) and the
 * browser's autofill profile (browser-autofill-store.ts).
 */
export function safeStorageProblem(f: { ready: boolean; available: boolean; platform: NodeJS.Platform; backend?: string }): string | undefined {
  if (!f.ready) return 'The app is still starting.';
  if (!f.available) return 'This computer offers no OS keychain to seal the vault key with.';
  if (f.platform === 'linux' && (f.backend === 'basic_text' || f.backend === 'unknown')) return 'No system keyring (GNOME Keyring or KWallet) is running.';
  return undefined;
}

// ── Plugin trust ─────────────────────────────────────────────────────────────

/**
 * A plugin's content, as one hash: every file's relative path and bytes, in
 * a fixed order. Trust is given to this hash, so any change to the files —
 * the agent's ide_plugin_save, a hand edit, a copied folder — needs the
 * person to trust it again.
 */
export function pluginContentHash(files: ReadonlyArray<{ rel: string; data: Buffer | string }>): string {
  const h = crypto.createHash('sha256');
  for (const f of [...files].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))) {
    const rel = f.rel.replace(/\\/g, '/');
    const data = typeof f.data === 'string' ? Buffer.from(f.data, 'utf8') : f.data;
    h.update(`${rel}\0${data.length}\0`);
    h.update(data);
  }
  return h.digest('hex');
}

/**
 * The trust list after comparing each trusted plugin with its files now: a
 * plugin whose hash changed is no longer trusted. A trust record from before
 * hashes existed takes the current hash (the person trusted that id already;
 * from now on a change revokes it).
 */
export function reconcilePluginTrust(
  trust: { trusted: readonly string[]; hashes?: Readonly<Record<string, string>> },
  current: Readonly<Record<string, string | undefined>>,
): { trusted: string[]; hashes: Record<string, string>; revoked: string[] } {
  const trusted: string[] = [];
  const hashes: Record<string, string> = {};
  const revoked: string[] = [];
  for (const id of trust.trusted) {
    const now = current[id];
    if (now === undefined) { trusted.push(id); if (trust.hashes?.[id]) hashes[id] = trust.hashes[id]!; continue; } // not installed (or unreadable): leave the record
    const was = trust.hashes?.[id];
    if (was && was !== now) { revoked.push(id); continue; }
    trusted.push(id);
    hashes[id] = now;
  }
  return { trusted, hashes, revoked };
}

// ── JavaScript dialogs ───────────────────────────────────────────────────────

/**
 * Whose words a JavaScript dialog shows: the frame that raised it, not the tab.
 * An ad or embedded frame on a trusted site could otherwise speak with that
 * site's name ("accounts.bank.com says: your session expired, re-enter…").
 */
export function dialogSource(frameUrl: string | undefined, topUrl: string): { host: string; embedded: boolean } {
  const hostOf = (u: string | undefined): string => {
    if (!u) return '';
    try { const x = new URL(u); return x.protocol === 'http:' || x.protocol === 'https:' ? x.host : x.protocol.replace(/:$/, ''); } catch { return ''; }
  };
  const top = hostOf(topUrl);
  const frame = hostOf(frameUrl) || top;
  return { host: frame, embedded: Boolean(frame && top && frame !== top) };
}
