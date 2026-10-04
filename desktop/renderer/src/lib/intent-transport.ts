/**
 * The desktop's API transport: `fetch`, plus the `x-aico-intent` header.
 *
 * WHY. Main attaches a one-time "a person did this" grant to requests on the
 * settings routes that need one (protocol.ts HUMAN_ROUTES). It used to do so
 * for any POST — and a plugin frame could post a plain HTML form there. Now
 * main mints the grant only for a JSON request carrying this header
 * (electron/protocol-policy.ts humanIntent): a form cannot set a header, and a
 * sandboxed frame has no fetch to the app. Code in the AICO window is the
 * person's interface, so its requests carry it.
 *
 * Imported for its side effect by every entry (main, browser window, copilot
 * overlay) before anything renders. The browser client and the VS Code panel
 * do not use it: their engine has no grant to mint.
 *
 * @module desktop/renderer/lib/intent-transport
 */

import { configureTransport } from '@web/transport';

configureTransport((url, init) => {
  const headers = new Headers(init?.headers);
  headers.set('x-aico-intent', '1');
  return fetch(url, { ...init, headers });
});
