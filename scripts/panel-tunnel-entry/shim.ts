/**
 * A webview, faked well enough to run its own code.
 *
 * `webview/src/tunnel.ts` calls `acquireVsCodeApi()` at module scope and listens
 * on `window`. Both have to exist *before* that module evaluates, which is why
 * this is a separate module imported first: ES module imports are hoisted, so a
 * shim written inline at the top of the entry point would still run second.
 *
 * The point of shimming rather than mocking is that the real tunnel code runs —
 * the `ReadableStream` reassembly, the abort naming, the head/body ordering. A
 * mock would only prove the mock works.
 *
 * @module scripts/panel-tunnel-entry/shim
 */

type Listener = (event: { data: unknown }) => void;

const listeners: Listener[] = [];

/** Frames the panel sent outward, for the host half to pick up. */
export const outbound: unknown[] = [];

/** Deliver a frame to the panel, as `window.postMessage` would. */
export function toPanel(message: unknown): void {
  for (const listener of [...listeners]) listener({ data: message });
}

const windowShim = {
  addEventListener: (type: string, listener: Listener) => {
    if (type === 'message') listeners.push(listener);
  },
  removeEventListener: (type: string, listener: Listener) => {
    const at = listeners.indexOf(listener);
    if (at >= 0) listeners.splice(at, 1);
  },
};

(globalThis as Record<string, unknown>).window = windowShim;
(globalThis as Record<string, unknown>).acquireVsCodeApi = () => ({
  postMessage: (message: unknown) => { outbound.push(message); },
  getState: () => undefined,
  setState: () => { /* nothing persists in a probe */ },
});

/*
  `api.ts` reads the token from localStorage. In the panel it is always absent —
  the host attaches the real one — so an empty store is the accurate shim, not a
  convenience.
*/
(globalThis as Record<string, unknown>).localStorage = {
  getItem: () => null,
  setItem: () => { /* discarded */ },
  removeItem: () => { /* discarded */ },
};
