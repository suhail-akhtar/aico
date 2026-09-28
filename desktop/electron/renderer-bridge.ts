/**
 * Main asks the interface a question and waits for the answer.
 *
 * Used by the agent's IDE tools: "what is on screen", "open this view",
 * "switch the theme". `command:call` goes out with an id; the renderer answers
 * with `command:reply`. A call with no window, or no answer in time, fails
 * with a message the agent can act on.
 *
 * @module desktop/electron/renderer-bridge
 */

import type { DesktopContext } from './context';

export function registerRendererBridge(ctx: DesktopContext): void {
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  let seq = 0;

  ctx.handle('command:reply', (id: string, reply: { result?: unknown; error?: string }) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    clearTimeout(p.timer);
    if (reply.error) p.reject(new Error(reply.error)); else p.resolve(reply.result);
  });

  ctx.services.renderer = {
    call<T>(method: string, params?: unknown, timeoutMs = 15_000): Promise<T> {
      const win = ctx.window();
      if (!win || win.isDestroyed()) return Promise.reject(new Error('The AICO window is not open.'));
      const id = `c${++seq}`;
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`The interface did not answer "${method}" in time.`)); }, timeoutMs);
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
        win.webContents.send('command:call', { id, method, params });
      });
    },
  };
}
