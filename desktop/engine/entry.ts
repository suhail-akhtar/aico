/**
 * The AICO engine, run inside Electron's utility process.
 *
 * This is `aico serve` with a different front door: the same `serve()` the CLI
 * and the VS Code extension start, so a session run here is the same session
 * the browser client and the terminal see. It is a process of its own so that
 * a long turn, a slow model or a runaway tool never blocks the window.
 *
 * Talks to main over `process.parentPort`:
 *   → { type: 'ready', url }            once listening
 *   → { type: 'error', message }        if it could not start
 *   ← { type: 'shutdown' }              close cleanly, then exit
 *
 * @module desktop/engine/entry
 */

import os from 'node:os';
import { serve } from '../../src/server/index.js';

interface ParentPort {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (e: { data: unknown }) => void): void;
}

const parent = (process as unknown as { parentPort?: ParentPort }).parentPort;

function send(message: unknown): void {
  if (parent) parent.postMessage(message);
  else console.log(JSON.stringify(message));
}

async function main(): Promise<void> {
  // The launch directory decides nothing here: sessions that name no project
  // run in the AICO workspace, exactly as they do from the browser client.
  const cwd = process.env.AICO_DESKTOP_CWD || os.homedir();
  // serve() resolves relative paths and spawns tools from here.
  try { process.chdir(cwd); } catch { /* stays where it started */ }
  try {
    const server = await serve({ port: 0, cwd, open: false });
    send({ type: 'ready', url: server.url });
    let closing = false;
    const shutdown = async (): Promise<void> => {
      if (closing) return;
      closing = true;
      try { await server.close(); } catch { /* exiting anyway */ }
      process.exit(0);
    };
    parent?.on('message', (e) => {
      if ((e.data as { type?: string } | undefined)?.type === 'shutdown') void shutdown();
    });
    process.on('SIGTERM', () => void shutdown());
  } catch (err) {
    send({ type: 'error', message: (err as Error).stack ?? String(err) });
    process.exit(1);
  }
}

void main();
