/**
 * The one way the desktop hands a link to the operating system.
 *
 * WHY. A security review (2026-10, D6) found shell.openExternal called in
 * several places with different (or no) scheme checks: the context menu's
 * "Open link" passed a page-controlled linkURL straight through, so a page
 * could make the OS open `file:`, `smb:` or an `ms-*` / app protocol handler
 * with arguments it chose. Every call now comes here, and the verdict is the
 * pure, unit-tested externalLinkAllowed (security-core.ts): http(s) and
 * mailto: only. scripts/test-security.mjs fails if any other main-process
 * module calls shell.openExternal directly.
 *
 * What it deliberately does not do: open a refused link some other way, or
 * ask the person — a refused link is logged and dropped. Links to http(s)
 * that should stay inside AICO's own browser are the caller's choice.
 *
 * @module desktop/electron/external-link
 */

import { shell } from 'electron';
import { externalLinkAllowed } from './security-core';

/**
 * Open `url` in the person's default app if it is http(s) or mailto:.
 * Resolves true when handed off, false when refused (and logged with `from`).
 */
export async function openExternalLink(url: string, from: string): Promise<boolean> {
  if (!externalLinkAllowed(url)) {
    const shown = typeof url === 'string' ? url.slice(0, 120) : typeof url;
    console.warn(`[aico] refused to open a non-web link externally (${from}): ${JSON.stringify(shown)}`);
    return false;
  }
  await shell.openExternal(url); // security-allow: open-external-unchecked — externalLinkAllowed above admits only http(s) with a host and mailto:
  return true;
}
