/**
 * The panel's only route to aico.
 *
 * The webview runs the same client code as the browser workspace, but a webview
 * has no way to reach `127.0.0.1` — its origin is `vscode-webview://`, and the
 * content-security policy that makes a webview safe to host would refuse the
 * request even if the origin allowed it.
 *
 * So the webview calls a `fetch` that posts a message here instead, and this
 * side does the real request. Three things follow from that, all of them wins:
 *
 * 1. **The token never leaves the extension host.** The browser client keeps it
 *    in `localStorage` because it has to; the panel never receives it. It is
 *    attached here, on the way past, and a compromised webview has nothing to
 *    steal.
 * 2. **No iframe, no port mapping.** The previous panel embedded the whole web
 *    app in an iframe and depended on `portMapping` handling http, and on the
 *    server's origin guard happening to pass. Neither is load-bearing any more.
 * 3. **The server is reached by its address, not by luck.** Requests are rewritten
 *    onto the running server's port here, so the webview's URLs stay relative and
 *    the client code needs no notion of where the server lives.
 *
 * ## Streaming is the reason this is not four lines
 *
 * `/api/events` is Server-Sent Events: one response that stays open for the
 * length of a run. It cannot be buffered and delivered as a body, so the
 * response is announced first and its text arrives as chunk messages, which the
 * webview reassembles into a `ReadableStream`. Everything else — plain JSON —
 * takes the simple path and arrives whole.
 *
 * @module view/http-tunnel
 */

import type * as vscode from 'vscode';
import type { ServerManager } from '../server';

/** A request from the webview. Mirrors the subset of `fetch` the client uses. */
export interface TunnelRequest {
  t: 'http';
  id: number;
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface TunnelAbort {
  t: 'http:abort';
  id: number;
}

/**
 * Everything the tunnel sends back, keyed by `id`.
 *
 * `head` always arrives first. A non-streaming response follows with one
 * `body`; a streaming one with any number of `chunk` frames and then `end`.
 * `error` can replace any of them, and is terminal.
 */
export type TunnelResponse =
  | { t: 'http:head'; id: number; status: number; ok: boolean; streaming: boolean }
  | { t: 'http:body'; id: number; text: string }
  | { t: 'http:chunk'; id: number; text: string }
  | { t: 'http:end'; id: number }
  | { t: 'http:error'; id: number; message: string };

export class HttpTunnel {
  /** In-flight requests, so an abort from the webview can actually stop one. */
  private readonly inFlight = new Map<number, AbortController>();

  constructor(
    private readonly server: ServerManager,
    private readonly post: (message: TunnelResponse) => void,
    private readonly log: vscode.OutputChannel,
  ) {}

  /** Cancel everything. Called when the view is disposed or the server stops. */
  abortAll(): void {
    for (const controller of this.inFlight.values()) {
      try { controller.abort(); } catch { /* already finished */ }
    }
    this.inFlight.clear();
  }

  abort(id: number): void {
    this.inFlight.get(id)?.abort();
    this.inFlight.delete(id);
  }

  async handle(req: TunnelRequest): Promise<void> {
    const controller = new AbortController();
    this.inFlight.set(req.id, controller);

    try {
      /*
        Start the server on first use rather than on activation.

        The panel is registered eagerly so its tab exists, but a person who
        opens VS Code on an unrelated project and never clicks the tab should
        not have an agent process started for them.
      */
      const running = await this.server.ensure();

      const url = new URL(req.url, `http://127.0.0.1:${running.port}`);
      /*
        The stream authenticates by query string, because the client cannot set
        a header on a request it wants to read incrementally in every browser.
        It is overwritten rather than appended to: the webview does not know the
        token, so whatever it sent is a placeholder.
      */
      if (url.searchParams.has('token')) url.searchParams.set('token', running.token);

      const res = await fetch(url.toString(), {
        method: req.method ?? 'GET',
        headers: { ...(req.headers ?? {}), 'x-aico-token': running.token },
        ...(req.body === undefined ? {} : { body: req.body }),
        signal: controller.signal,
      });

      const streaming = (res.headers.get('content-type') ?? '')
        .includes('text/event-stream');
      this.post({ t: 'http:head', id: req.id, status: res.status, ok: res.ok, streaming });

      if (!streaming || !res.body) {
        this.post({ t: 'http:body', id: req.id, text: await res.text() });
        this.post({ t: 'http:end', id: req.id });
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        /*
          `stream: true` matters. A multi-byte character split across two TCP
          reads decodes to a replacement character without it, and the frame it
          was part of then fails to parse — losing a message from the middle of
          a run rather than failing loudly.
        */
        const text = decoder.decode(value, { stream: true });
        if (text) this.post({ t: 'http:chunk', id: req.id, text });
      }
      this.post({ t: 'http:end', id: req.id });
    } catch (err) {
      // An abort is the client changing its mind, not a failure. Reporting it
      // would surface a red error every time a session is switched.
      if ((err as Error)?.name === 'AbortError') {
        this.post({ t: 'http:end', id: req.id });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.log.appendLine(`[tunnel] ${req.method ?? 'GET'} ${req.url} — ${message}`);
      this.post({ t: 'http:error', id: req.id, message });
    } finally {
      this.inFlight.delete(req.id);
    }
  }
}
