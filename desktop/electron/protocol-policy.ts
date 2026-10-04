/**
 * The `aico://` scheme's policies as data: the content-security policies of
 * the app and of plugin files, and the rule for when a request to a settings
 * route counts as the person's own click (and so gets a human grant).
 *
 * WHY a module of its own: protocol.ts registers the scheme with Electron and
 * cannot be loaded by a Node test. A security review (2026-10) found that a
 * plugin frame could POST a plain HTML form to `aico://app/api/settings` —
 * `connect-src 'none'` stops fetch, not form submission — and main attached
 * a grant to any POST on a human route. Now the policies carry
 * `form-action 'none'`, and a grant is minted only for a request that a
 * form or a simple cross-origin request cannot make: JSON, with the
 * `x-aico-intent` header the app's own transport adds, from the app's origin.
 * scripts/test-security.mjs checks both.
 *
 * What it does not do: decide which routes need a person (HUMAN_ROUTES in
 * protocol.ts, beside the proxy) or check the grant (the engine's
 * decision-gate.ts spends it).
 *
 * @module desktop/electron/protocol-policy
 */

/** The renderer's own content-security policy. */
export const APP_CSP = [
  "default-src 'self' aico:",
  "script-src 'self' aico: 'wasm-unsafe-eval'",
  // Mermaid, KaTeX and ECharts write inline styles.
  "style-src 'self' aico: 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' aico: data: https://fonts.gstatic.com",
  "img-src 'self' aico: data: blob: https: http:",
  "media-src 'self' aico: data: blob:",
  "connect-src 'self' aico:",
  // Plugin views and HTML previews are sandboxed frames. The ```video block
  // embeds YouTube's no-cookie player, and only after the reader clicks play.
  // (Remote images — map tiles, thumbnails, product photos — are already
  // covered by img-src https:.)
  "frame-src 'self' aico: blob: data: https://www.youtube-nocookie.com",
  "worker-src 'self' aico: blob:",
  "object-src 'none'",
  "base-uri 'self'",
  // The app submits no HTML forms; a form is how a frame would reach the API without fetch.
  "form-action 'none'",
].join('; ');

/**
 * A plugin's files: scripts may run, but inside an opaque-origin sandbox — no
 * access to the app's origin, its storage or its bridge, no connections and
 * no form submissions (allow-forms is kept for in-page form controls; the
 * policy refuses where they would post).
 */
export const PLUGIN_CSP = [
  "default-src 'self' aico: data: blob:",
  "script-src 'self' aico: 'unsafe-inline'",
  "style-src 'self' aico: 'unsafe-inline'",
  "img-src * data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  'sandbox allow-scripts allow-forms allow-popups',
].join('; ');

/** The header the app's own API transport adds to every request (desktop/renderer/src/lib/intent-transport.ts). */
export const INTENT_HEADER = 'x-aico-intent';

/**
 * Is this request to a human route the app's own, made by code in the AICO
 * window? A form post can be text/plain, multipart or urlencoded and cannot
 * add headers; a cross-origin fetch with a custom header needs a preflight
 * the scheme never answers. So: POST, JSON, the intent header, and an Origin
 * (when one is sent) of the app itself.
 */
export function humanIntent(req: { method: string; headers: { get(name: string): string | null } }, appOrigin: string): boolean {
  if (req.method !== 'POST') return false;
  if (req.headers.get(INTENT_HEADER) !== '1') return false;
  const type = (req.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (type !== 'application/json') return false;
  const origin = req.headers.get('origin');
  if (origin !== null && origin !== appOrigin) return false;
  return true;
}
