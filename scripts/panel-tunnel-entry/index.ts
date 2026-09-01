/**
 * Both halves of the panel's transport, wired together.
 *
 * The probe that imports this runs a real `aico serve` and drives the *actual*
 * client — `web/src/api.ts` and its SSE reader — through the *actual* tunnel, in
 * both directions. Nothing here is a stand-in except the message channel between
 * them, which in VS Code is `postMessage` and here is a function call.
 *
 * That is the whole point. The risk in this design is not that a JSON request
 * fails; it is that a streamed response does not survive being taken apart into
 * `postMessage` frames and put back together as a `ReadableStream` — and no
 * amount of typechecking says anything about that.
 *
 * @module scripts/panel-tunnel-entry
 */

// Must be first: it defines `window` and `acquireVsCodeApi` for the module below.
import { outbound, toPanel } from './shim';

import { HttpTunnel } from '../../vscode-extension/src/view/http-tunnel';
import { supportsSecondarySidebar } from '../../vscode-extension/src/view/vscode-version';
import { sameFolder } from '../../vscode-extension/webview/src/paths';
import {
  buildContextBlock, chipKey, EMPTY, NO_ATTACHMENTS,
} from '../../vscode-extension/webview/src/context';
import { tunnelFetch } from '../../vscode-extension/webview/src/tunnel';
import { configureTransport } from '../../web/src/transport';
import { api, streamSession, type StreamEvent } from '../../web/src/api';

export interface Wiring {
  /** Everything the host answered with, in order. Asserted on by the probe. */
  frames: unknown[];
  /** Requests the host declined to start, because the server was unreachable. */
  stop: () => void;
}

/**
 * Connect a panel to a server, exactly as the extension does.
 *
 * `server` stands in for `ServerManager` — the tunnel only ever calls `ensure()`
 * on it, which is the seam that makes this testable without VS Code at all.
 */
export function wire(port: number, token: string): Wiring {
  const frames: unknown[] = [];

  const tunnel = new HttpTunnel(
    { ensure: async () => ({ url: `http://127.0.0.1:${port}/`, port, token }) } as never,
    (message) => { frames.push(message); toPanel(message); },
    { appendLine: () => { /* the probe reports its own failures */ } } as never,
  );

  /*
    Drain what the panel posts outward.

    In VS Code this is `onDidReceiveMessage`. Polling rather than patching
    `postMessage` keeps the shim honest: the panel really does write to an array
    and really does have to be read from asynchronously, which is the ordering
    the real thing has too.
  */
  const pump = setInterval(() => {
    while (outbound.length) {
      const message = outbound.shift() as { t?: string; id?: number };
      if (message?.t === 'http') void tunnel.handle(message as never);
      if (message?.t === 'http:abort' && typeof message.id === 'number') tunnel.abort(message.id);
    }
  }, 2);

  configureTransport(tunnelFetch);

  return {
    frames,
    stop: () => { clearInterval(pump); tunnel.abortAll(); },
  };
}

export {
  api, streamSession, supportsSecondarySidebar, sameFolder,
  buildContextBlock, chipKey, EMPTY, NO_ATTACHMENTS,
};
export type { StreamEvent };
