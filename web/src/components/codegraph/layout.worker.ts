/**
 * The Code map's layout, off the main thread: runs {@link ForceLayout} and
 * posts positions back every few ticks, so the picture settles while the page
 * stays responsive on a 5,000-file project.
 *
 * Messages in: `{ type: 'start', n, edges, groups, mass, init?, maxTicks? }`, `{ type: 'stop' }`.
 * Messages out: `{ type: 'positions', pos, alpha, done }` (pos is a transferred copy).
 *
 * @module web/components/codegraph/layout.worker
 */

import { ForceLayout } from './layout';

let running: ForceLayout | null = null;
let generation = 0;

interface StartMessage { type: 'start'; n: number; edges: Int32Array; groups: Int32Array; mass: Float32Array; init?: Float32Array; maxTicks?: number }

self.onmessage = (ev: MessageEvent<StartMessage | { type: 'stop' }>) => {
  const msg = ev.data;
  if (msg.type === 'stop') { generation++; running = null; return; }
  const mine = ++generation;
  running = new ForceLayout({ n: msg.n, edges: msg.edges, groups: msg.groups, mass: msg.mass }, msg.init);
  const maxTicks = msg.maxTicks ?? 320;
  const step = (): void => {
    if (mine !== generation || !running) return;
    const started = performance.now();
    let moved = Infinity;
    // About a frame's worth of work per message, so positions stream at a steady rate.
    while (performance.now() - started < 24 && running.ticks < maxTicks) moved = running.tick();
    const done = running.ticks >= maxTicks || (moved < 0.05 && running.alpha < 0.2);
    const pos = Float32Array.from(running.pos);
    (self as unknown as Worker).postMessage({ type: 'positions', pos, alpha: running.alpha, done }, [pos.buffer]);
    if (!done) setTimeout(step, 0);
  };
  step();
};
