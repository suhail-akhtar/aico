/**
 * Where `api.ts` sends its requests.
 *
 * In the browser this is one line of indirection over `fetch` and could be
 * deleted. It exists for the VS Code panel, which has the same client code but
 * no route to the server: a webview's origin is `vscode-webview://`, it cannot
 * reach `127.0.0.1`, and its content-security policy would refuse if it could.
 *
 * So the panel supplies a `fetch` that tunnels over `postMessage` to the
 * extension host, which holds the real connection. Everything in `api.ts` —
 * JSON requests, the SSE reader, the 401 path — works unchanged, because all of
 * it goes through `fetch` and reads `res.ok`, `res.text()` and `res.body`.
 *
 * The security property is better there than here, not worse. The browser
 * client holds the server token in `localStorage`; the panel never sees it at
 * all, because the host attaches it on the way past.
 *
 * @module transport
 */

/** Narrow on purpose: `api.ts` only ever calls fetch with a string URL. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

let impl: FetchLike | null = null;

/**
 * Route every API call through `fetchImpl` instead of the global `fetch`.
 *
 * Call once, before anything renders. Calling it twice is not an error — the
 * last one wins — but a client that swaps transports mid-session would leave an
 * in-flight SSE reader attached to the previous one.
 */
export function configureTransport(fetchImpl: FetchLike): void {
  impl = fetchImpl;
}

/** True once a host has taken over the transport. The panel; never the browser. */
export function isTunnelled(): boolean {
  return impl !== null;
}

export function transportFetch(url: string, init?: RequestInit): Promise<Response> {
  return impl ? impl(url, init) : fetch(url, init);
}
