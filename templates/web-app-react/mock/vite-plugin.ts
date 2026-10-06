/**
 * Serves the mock gateway (`mock/api.ts`) from the Vite dev and preview servers.
 *
 * Why: `npm run dev` should show a signed-in-able app the moment it is created,
 * and the end-to-end suite needs a stack it can start with no Docker. Both get
 * it by mounting the same Fetch-API implementation in front of Vite's static
 * serving. Set `DEV_API_ORIGIN` to proxy `/api` to a real gateway instead (the
 * mock then stays out of the way).
 *
 * What it does not do: run in production. `vite build` never loads this file's
 * handlers; the production image has nginx and a real gateway instead.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { Connect, Plugin } from 'vite';
import { createMockStack, type MockOptions } from './api.ts';

function toRequest(req: IncomingMessage): Request {
  const host = req.headers.host ?? 'localhost';
  const method = req.method ?? 'GET';
  const init: RequestInit & { duplex?: 'half' } = {
    method,
    headers: Object.entries(req.headers).flatMap(([k, v]) =>
      v === undefined ? [] : [[k, Array.isArray(v) ? v.join(', ') : v] as [string, string]],
    ),
  };
  if (method !== 'GET' && method !== 'HEAD') {
    init.body = Readable.toWeb(req) as unknown as ReadableStream;
    init.duplex = 'half';
  }
  return new Request(`http://${host}${req.url ?? '/'}`, init);
}

async function send(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  for (const [name, value] of response.headers) {
    if (name.toLowerCase() !== 'set-cookie') res.setHeader(name, value);
  }
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) res.setHeader('Set-Cookie', cookies);
  res.end(Buffer.from(await response.arrayBuffer()));
}

export function mockGateway(options: MockOptions = {}): Plugin {
  const stack = createMockStack(options);
  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    stack
      .handle(toRequest(req))
      .then((response) => (response ? send(res, response) : next()))
      .catch(next);
  };
  return {
    name: 'mock-gateway',
    apply: () => !process.env.DEV_API_ORIGIN,
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
