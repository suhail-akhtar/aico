/**
 * The few pages the server renders itself: the device-approval page and plain
 * messages. They are server-rendered (no script) on purpose: the page where a
 * person decides "yes, connect this machine" should be the smallest thing that
 * can possibly work, and it must show *which* machine is asking so a code
 * phished from someone else is recognisable as not theirs.
 *
 * Every dynamic value goes through `esc`. The CSP forbids scripts entirely.
 *
 * @module pages
 */

import { esc } from './http.js';

const STYLE = `
:root{color-scheme:light dark;--bg:#f6f5f2;--card:#fff;--ink:#1a1d21;--muted:#5d6670;--line:#dcd9d2;--accent:#1f5f5b;--accent-ink:#fff;--bad:#a3341f}
@media(prefers-color-scheme:dark){:root{--bg:#14171a;--card:#1c2024;--ink:#eceae4;--muted:#9aa3ab;--line:#2c3238;--accent:#6bc1b8;--accent-ink:#0d1a19;--bad:#f08a76}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:16px}
main{width:100%;max-width:440px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px 28px 24px}
h1{font-size:1.35rem;margin:0 0 4px;letter-spacing:-.01em}p{margin:8px 0;color:var(--muted)}.who{font-size:.85rem}
.code{font:600 1.6rem/1.2 ui-monospace,Consolas,monospace;letter-spacing:.14em;margin:14px 0;color:var(--ink)}
dl{display:grid;grid-template-columns:auto 1fr;gap:4px 14px;margin:14px 0;font-size:.92rem}dt{color:var(--muted)}dd{margin:0}
input[type=text]{width:100%;font:600 1.2rem ui-monospace,Consolas,monospace;letter-spacing:.12em;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:transparent;color:var(--ink);text-transform:uppercase}
.row{display:flex;gap:10px;margin-top:18px}button{font:inherit;font-weight:600;padding:10px 18px;border-radius:8px;border:1px solid var(--line);background:transparent;color:var(--ink);cursor:pointer}
button.primary{background:var(--accent);color:var(--accent-ink);border-color:var(--accent)}button:focus-visible,input:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.err{color:var(--bad);font-size:.92rem}
`;

const shell = (title: string, inner: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} - AICO Control</title><style>${STYLE}</style></head><body><main>${inner}</main></body></html>`;

export const messagePage = (title: string, message: string): string => shell(title, `<h1>${esc(title)}</h1><p>${esc(message)}</p>`);

export function devicePage(o: {
  email: string; tenantName: string; csrf: string; code: string; notFound: boolean;
  grant?: { deviceName: string; platform: string; aicoVersion: string };
}): string {
  const who = `<p class="who">Signed in to ${esc(o.tenantName)} as ${esc(o.email)}</p>`;
  if (!o.grant) {
    return shell('Connect a device', `<h1>Connect a device</h1>${who}
      <p>Enter the code shown by <code>aico control login</code> in your terminal or the AICO app.</p>
      ${o.notFound ? '<p class="err">That code was not found or has expired. Check it and try again.</p>' : ''}
      <form method="get" action="/device"><p><input type="text" name="code" value="${esc(o.code)}" placeholder="ABCD-EFGH" autocomplete="off" autofocus maxlength="12"></p>
      <div class="row"><button class="primary" type="submit">Continue</button></div></form>`);
  }
  return shell('Connect a device', `<h1>Connect this device?</h1>${who}
    <div class="code" aria-label="Code">${esc(o.code)}</div>
    <dl><dt>Device</dt><dd>${esc(o.grant.deviceName)}</dd><dt>System</dt><dd>${esc(o.grant.platform || 'unknown')}</dd><dt>AICO</dt><dd>${esc(o.grant.aicoVersion || 'unknown')}</dd></dl>
    <p>Only approve if you started this on your own machine just now. It will apply your organisation's policy there and report usage and audit events back.</p>
    <form method="post" action="/device/decision"><input type="hidden" name="csrf" value="${esc(o.csrf)}"><input type="hidden" name="code" value="${esc(o.code)}">
    <div class="row"><button class="primary" type="submit" name="decision" value="approve">Approve</button><button type="submit" name="decision" value="deny">Deny</button></div></form>`);
}
