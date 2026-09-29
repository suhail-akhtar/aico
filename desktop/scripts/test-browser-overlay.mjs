/**
 * Unit tests for the floating copilot's own view: the geometry both sides of
 * the window share (where the panel may go, how a drag and a resize move it,
 * the overlay view's bounds) and the rule that keeps the two documents' copies
 * of the copilot's look in step. Bundled with esbuild and run in Node, like
 * test-unit.mjs.
 *
 *   node scripts/test-browser-overlay.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-desk-overlay-'));

async function load(entry, name) {
  const file = path.join(out, `${name}.mjs`);
  await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile: file, logLevel: 'error' });
  return import(pathToFileURL(file).href);
}

let pass = 0; let fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); }
}

const f = await load(path.join(desktop, 'shared/copilot-float.ts'), 'copilot-float');
const geo = await load(path.join(desktop, 'renderer/src/browser/geometry.ts'), 'browser-geometry');

// ── Placement ──
{
  const probe = { x: 5000, y: -50, w: 400, h: 560 };
  ok(JSON.stringify(geo.clampFloat(probe, { width: 1000, height: 700 })) === JSON.stringify(f.clampFloat(probe, { width: 1000, height: 700 })) && typeof geo.dragFloat === 'function', 'geometry: the renderer uses the shared arithmetic');
  const area = { width: 1000, height: 700 };
  const first = f.clampFloat({ x: -1, y: 16, w: 400, h: 560 }, area);
  ok(first.x === 584 && first.y === 16, 'place: not placed yet goes top-right', first);
  const small = f.clampFloat({ x: 10, y: 10, w: 900, h: 900 }, { width: 500, height: 400 });
  ok(small.w === 484 && small.h === 384, 'place: never larger than the area', small);
}

// ── Drag and resize ──
{
  const area = { width: 1000, height: 700 };
  const start = { x: 500, y: 40, w: 400, h: 500 };
  const moved = f.dragFloat(start, -120, 30, area);
  ok(moved.x === 380 && moved.y === 70 && moved.w === 400 && moved.h === 500, 'drag: follows the pointer, size unchanged', moved);
  const far = f.dragFloat(start, 5000, 5000, area);
  ok(far.x === 1000 - 400 - 8 && far.y === 700 - 500 - 8, 'drag: stops at the area edge', far);
  const back = f.dragFloat(start, -5000, -5000, area);
  ok(back.x === 8 && back.y === 8, 'drag: stops at the top-left margin', back);
  const grown = f.resizeFloat(start, -100, 50, area);
  ok(grown.x + grown.w === start.x + start.w && grown.w === 500 && grown.h === 550 && grown.y === start.y, 'resize: bottom-left grip keeps the right edge and the top', grown);
  const tiny = f.resizeFloat(start, 400, -400, area);
  ok(tiny.w === 320 && tiny.h === 300 && tiny.x + tiny.w === 900, 'resize: never smaller than the minimum', tiny);
  const huge = f.resizeFloat(start, -2000, 2000, area);
  ok(huge.x === 8 && huge.y + huge.h === 700 - 8, 'resize: never past the area', huge);
}

// ── The overlay view's bounds ──
{
  const area = { x: 60, y: 120, width: 1000, height: 700 };
  const box = { x: 500, y: 40, w: 400, h: 500 };
  const { bounds, panel } = f.overlayLayout(area, box, 1);
  const s = f.FLOAT_SHADOW;
  ok(bounds.x === 60 + 500 - s && bounds.y === 120 + 40 - s && bounds.width === 400 + 2 * s && bounds.height === 500 + 2 * s, 'overlay: the panel plus its shadow margin, in window coordinates', bounds);
  ok(panel.x === s && panel.y === s && panel.width === 400 && panel.height === 500, 'overlay: the panel sits inside the margin', panel);
  const z = f.overlayLayout(area, box, 1.25).bounds;
  ok(z.x === Math.round((60 + 500 - s) * 1.25) && z.width === Math.round((400 + 2 * s) * 1.25), 'overlay: a zoomed interface scales CSS pixels to window pixels', z);
  const edge = f.overlayLayout(area, { x: 5000, y: -50, w: 400, h: 500 }, 1);
  ok(edge.bounds.x + edge.bounds.width <= area.x + area.width && edge.bounds.y >= area.y, 'overlay: never outside the area (toolbar, status line)', edge.bounds);
  const cramped = f.overlayLayout({ x: 0, y: 100, width: 300, height: 260 }, box, 1);
  ok(cramped.bounds.x >= 0 && cramped.bounds.y >= 100 && cramped.bounds.y + cramped.bounds.height <= 360 && cramped.bounds.x + cramped.bounds.width <= 300,
    'overlay: an area smaller than the panel still clips the view to it', cramped.bounds);
  ok(cramped.panel.x === (0 + 8) - cramped.bounds.x && cramped.panel.width === 320, 'overlay: …and says where the (minimum-size) panel sits', cramped.panel);
  ok(f.FLOAT_SHADOW <= f.FLOAT_MARGIN, 'overlay: the shadow margin fits in the area margin');
}

// ── Keeping the two documents in step ──
{
  const local = { open: true, minimized: false, mode: 'float', x: 10, y: 20, w: 400, h: 560, dockWidth: 400, attachPage: true, prefill: { text: 'hi', at: 1 } };
  const same = JSON.stringify({ open: true, minimized: false, mode: 'float', x: 10, y: 20, w: 400, h: 560, dockWidth: 400, attachPage: true });
  ok(f.remoteUiPatch(local, same) === null, 'sync: nothing changed, nothing applied (so nothing is written back)');
  const moved = f.remoteUiPatch(local, JSON.stringify({ ...JSON.parse(same), x: 99, y: 7 }));
  ok(moved && moved.x === 99 && moved.y === 7 && Object.keys(moved).length === 2, 'sync: only what changed is applied', moved);
  const docked = f.remoteUiPatch(local, JSON.stringify({ ...JSON.parse(same), mode: 'dock', minimized: true }));
  ok(docked && docked.mode === 'dock' && docked.minimized === true, 'sync: docking or minimising in the other document is seen', docked);
  ok(!('prefill' in (f.remoteUiPatch(local, JSON.stringify({ ...JSON.parse(same), open: false, prefill: { text: 'x', at: 2 } })) ?? {})), 'sync: a prefill in flight is never overwritten');
  ok(f.remoteUiPatch(local, '{not json') === null && f.remoteUiPatch(local, null) === null, 'sync: an unreadable or removed record is ignored');
  const junk = f.remoteUiPatch(local, JSON.stringify({ mode: 'sideways', x: 'far', open: 1 }));
  ok(junk === null, 'sync: fields of the wrong kind are ignored', junk);
}

fs.rmSync(out, { recursive: true, force: true });
console.log(`\n  BROWSER OVERLAY UNIT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
