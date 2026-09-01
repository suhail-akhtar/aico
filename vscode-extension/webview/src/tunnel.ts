/**
 * A `fetch` that goes through the extension host.
 *
 * The panel reuses aico's browser client wholesale — `api.ts`, the reducer, the
 * store — and all of it makes requests with `fetch` and reads the result as a
 * `Response`. So rather than fork that code for VS Code, this hands it a `fetch`
 * that satisfies the same contract and answers over `postMessage`.
 *
 * Reassembling a real `Response` matters, and is why this is not a thin shim.
 * `streamSession` does `res.body.getReader()` and decodes SSE frames itself; it
 * has to keep working unchanged, because it is where resumable streaming lives —
 * the part that makes a dropped connection cost nothing. So a streamed reply is
 * rebuilt into a `ReadableStream` here and handed over as if the network had
 * produced it.
 *
 * @module tunnel
 */

interface VsCodeApi {
  postMessage: (message: unknown) => void;
  getState: () => unknown;
  setState: (state: unknown) => void;
}

declare function acquireVsCodeApi(): VsCodeApi;

/**
 * `acquireVsCodeApi` may be called exactly once per document, so the handle is
 * taken here and shared. A second call throws, and it throws in a way that takes
 * the whole panel down at import time.
 */
export const vscodeApi: VsCodeApi = acquireVsCodeApi();

interface Pending {
  resolve: (res: Response) => void;
  reject: (err: Error) => void;
  /** Carried from the head frame so the body frame can build the Response. */
  status: number;
  /** Whether `resolve`/`reject` has already been called. */
  settled: boolean;
  /** Set only for a streamed reply, once its ReadableStream exists. */
  push?: (text: string) => void;
  close?: () => void;
  fail?: (err: Error) => void;
}

const pending = new Map<number, Pending>();
let nextId = 1;

/*
  One listener, deliberately.

  An earlier draft split head-bookkeeping into a second listener and it was
  wrong in a way that would have been miserable to find: listeners run in
  registration order, so the frame handler saw a status the bookkeeper had not
  recorded yet, and every response quietly became a 200 — including the 401 that
  is supposed to trigger re-authentication.
*/
window.addEventListener('message', (event: MessageEvent) => {
  const frame = event.data as { t?: string; id?: number } | undefined;
  if (typeof frame?.t !== 'string' || !frame.t.startsWith('http:')) return;
  if (typeof frame.id !== 'number') return;

  const entry = pending.get(frame.id);
  if (!entry) return;

  const f = frame as Record<string, unknown> & { t: string; id: number };

  switch (f.t) {
    case 'http:head': {
      entry.status = (f.status as number) ?? 200;
      if (!f.streaming) return; // the body frame completes it
      /*
        A streaming response resolves as soon as its head arrives, not when it
        ends — the whole point is that the caller starts reading while the run is
        still producing. The stream stays open until `http:end`.
      */
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          entry.push = (text) => controller.enqueue(encoder.encode(text));
          entry.close = () => { try { controller.close(); } catch { /* already closed */ } };
          entry.fail = (err) => { try { controller.error(err); } catch { /* already errored */ } };
        },
      });
      entry.settled = true;
      entry.resolve(new Response(stream, { status: entry.status }));
      return;
    }

    case 'http:body': {
      entry.settled = true;
      entry.resolve(new Response(f.text as string, { status: entry.status }));
      return;
    }

    case 'http:chunk': {
      entry.push?.(f.text as string);
      return;
    }

    case 'http:end': {
      entry.close?.();
      // An aborted request ends without ever producing a head. Nothing is
      // waiting on the result by then, but the entry still has to go.
      pending.delete(f.id);
      return;
    }

    case 'http:error': {
      const err = new Error(f.message as string);
      if (entry.settled) entry.fail?.(err); else entry.reject(err);
      pending.delete(f.id);
      return;
    }
  }
});

export function tunnelFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const id = nextId; nextId += 1;

  return new Promise<Response>((resolve, reject) => {
    const signal = init.signal;
    if (signal?.aborted) { reject(abortError()); return; }

    pending.set(id, { resolve, reject, status: 200, settled: false });

    signal?.addEventListener('abort', () => {
      const entry = pending.get(id);
      vscodeApi.postMessage({ t: 'http:abort', id });
      if (entry && !entry.settled) { pending.delete(id); reject(abortError()); }
    }, { once: true });

    vscodeApi.postMessage({
      t: 'http',
      id,
      url,
      method: init.method ?? 'GET',
      headers: normaliseHeaders(init.headers),
      body: typeof init.body === 'string' ? init.body : undefined,
    });
  });
}

/**
 * The name is the contract.
 *
 * `streamSession` reconnects on failure but must *not* reconnect after a
 * deliberate close, and it tells the two apart by `err.name === 'AbortError'`.
 * A plain Error here would make every session switch reconnect the session that
 * was just left.
 */
function abortError(): Error {
  const err = new Error('The user aborted a request.');
  err.name = 'AbortError';
  return err;
}

function normaliseHeaders(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return { ...headers };
}
