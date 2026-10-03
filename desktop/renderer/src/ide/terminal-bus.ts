/**
 * The door every "open a terminal" request comes through — and a queue in
 * front of it.
 *
 * WHY. Callers (project pages, the file explorer's "Open terminal here", the
 * palette, plugin commands) open the bottom panel and fire `desk:terminal` in
 * the same tick. The terminal panel is lazily loaded, so on a closed panel the
 * event fired before anything listened: the request was lost and the panel
 * opened a default terminal somewhere else. This module is imported eagerly
 * (shell/BottomPanel.tsx), listens from app start, and holds requests until
 * the panel takes them.
 *
 * @module desktop/renderer/ide/terminal-bus
 */

export interface TerminalRequest { cwd?: string; run?: string }

const queue: TerminalRequest[] = [];
let handler: ((r: TerminalRequest) => void) | null = null;

window.addEventListener('desk:terminal', (e: Event) => {
  const d = (e as CustomEvent<TerminalRequest>).detail ?? {};
  const req: TerminalRequest = {
    ...(typeof d.cwd === 'string' && d.cwd ? { cwd: d.cwd } : {}),
    ...(typeof d.run === 'string' && d.run ? { run: d.run } : {}),
  };
  if (handler) handler(req); else queue.push(req);
});

/** Take requests (queued ones first). Returns the unsubscriber. */
export function onTerminalRequest(h: (r: TerminalRequest) => void): () => void {
  handler = h;
  while (queue.length) h(queue.shift()!);
  return () => { if (handler === h) handler = null; };
}

/** Whether a request is waiting — the panel then skips opening its default terminal. */
export function hasPendingTerminalRequest(): boolean {
  return queue.length > 0;
}
