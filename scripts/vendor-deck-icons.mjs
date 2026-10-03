/**
 * Vendor the deck icon set: a curated subset of Lucide (ISC; its Feather-derived
 * icons carry Feather's notice — both kept in `shared/ui/canvas/vendor/lucide/LICENSE`)
 * converted to one normalised path per icon.
 *
 * Why normalised paths and not the SVG files: an icon on a slide must be the
 * same drawing in the editor (SVG) and in PowerPoint, where it is a native,
 * recolourable freeform (`a:custGeom`). DrawingML paths have moveTo, lnTo,
 * cubicBezTo and close — no arcs in SVG's endpoint form, no circles, no
 * relative commands — so every element (path with any command, circle,
 * ellipse, rect with corner radius, line, polyline, polygon) is converted here,
 * once, to absolute `M x y`, `L x y`, `C …`, `Z` in the 24×24 box. The engine
 * then never parses SVG at run time, and both renderers read the same numbers.
 *
 * Run by hand when the curated list changes (no runtime dependency, nothing
 * fetched by the build):
 *   npm pack lucide-static && tar -xzf lucide-static-*.tgz
 *   node scripts/vendor-deck-icons.mjs <path to the extracted package/>
 *
 * @module scripts/vendor-deck-icons
 */

import fs from 'node:fs';
import path from 'node:path';

const pkg = process.argv[2];
if (!pkg || !fs.existsSync(path.join(pkg, 'icon-nodes.json'))) {
  console.error('usage: node scripts/vendor-deck-icons.mjs <extracted lucide-static package dir>');
  process.exit(2);
}
const nodes = JSON.parse(fs.readFileSync(path.join(pkg, 'icon-nodes.json'), 'utf8'));
const tags = JSON.parse(fs.readFileSync(path.join(pkg, 'tags.json'), 'utf8'));
const version = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8')).version;

// Business, technology, people, education, health, finance, logistics, nature — what slides are about.
const CURATED = `
briefcase briefcase-business building building-2 factory store landmark handshake users user user-plus user-check users-round
contact id-card badge-check award trophy medal crown star target crosshair flag rocket lightbulb brain puzzle gem diamond heart
heart-handshake smile thumbs-up message-circle message-square messages-square mail phone megaphone bell calendar calendar-check
calendar-days calendar-clock clock timer hourglass alarm-clock history dollar-sign euro pound-sterling coins banknote wallet
credit-card piggy-bank receipt calculator percent trending-up trending-down chart-line chart-bar chart-pie chart-column chart-area
chart-no-axes-combined chart-candlestick chart-gantt activity gauge scale shopping-cart shopping-bag shopping-basket package
package-check truck ship plane globe earth map map-pin navigation compass route signpost milestone server server-cog database
database-backup hard-drive cpu microchip memory-stick monitor laptop smartphone tablet cloud cloud-upload cloud-download cloud-cog
wifi network router cable plug plug-zap zap battery battery-charging code code-xml terminal git-branch git-merge git-pull-request
git-fork bug cog settings wrench hammer sliders-horizontal layers layers-3 layout-dashboard layout-grid app-window box boxes
container blocks component workflow share-2 link key key-round lock lock-keyhole unlock shield shield-check shield-alert
fingerprint scan eye search filter refresh-cw rotate-cw repeat infinity arrow-right arrow-up-right chevrons-right move-right check
circle-check check-check x circle-x triangle-alert info circle-question-mark plus minus file file-text files folder folder-open
clipboard clipboard-check clipboard-list list-checks list-todo list-ordered notebook notebook-pen book book-open book-marked
graduation-cap school library pencil pen-tool palette brush image camera video film mic headphones music play presentation
projector tv newspaper rss at-sign send inbox archive download upload save printer trash-2 recycle leaf sprout tree-pine sun moon
cloud-sun droplet flame wind thermometer mountain waves house hospital stethoscope heart-pulse pill syringe baby accessibility hand
hand-heart hand-helping hand-coins gift party-popper coffee utensils car bus train-front bike fuel sparkles sparkle wand-sparkles
bot bot-message-square brain-circuit circuit-board satellite satellite-dish radar atom flask-conical microscope dna test-tube ruler
scissors magnet anchor umbrella life-buoy siren construction hard-hat warehouse forklift tractor wheat apple shirt glasses ticket
tag tags barcode qr-code goal circle-dot user-cog split merge combine shuffle kanban table sheet file-spreadsheet scroll gavel
badge-dollar-sign circle-dollar-sign receipt-text bitcoin vault mouse-pointer-click monitor-smartphone globe-lock signal antenna
radio-tower power earth-lock languages footprints laugh quote message-square-quote timer-reset alarm-clock-check badge-percent
handshake hand-platter heart-plus smile-plus user-round-check users-round user-round-plus contact-round school-2? ear eye-off
lightbulb-off mail-check mail-open phone-call video-camera? webcam cast airplay keyboard mouse headset podcast radio
megaphone-off target-arrow? crosshair goal medal ribbon? backpack luggage hotel bed-double tent ferris-wheel? palette swatch-book
paintbrush pipette shapes square-stack chart-scatter chart-spline chart-network chart-pie? trending-up-down arrow-big-up arrow-big-right
trash list-filter waves-horizontal fingerprint-pattern building-complex layers-2 book-check
`.split(/\s+/).map(s => s.replace(/\?$/, '')).filter(Boolean);

// ── SVG geometry → absolute M/L/C/Z ────────────────────────────────

const r2 = (n) => Math.round(n * 100) / 100;
const fmt = (n) => { const v = r2(n); return Object.is(v, -0) ? '0' : String(v); };

/** Arc (SVG endpoint form) → cubic Béziers. */
function arcToCubics(x1, y1, rx, ry, phi, fa, fs, x2, y2) {
  if (rx === 0 || ry === 0) return [[x1, y1, x2, y2, x2, y2]];
  const rad = (phi * Math.PI) / 180;
  const cos = Math.cos(rad); const sin = Math.sin(rad);
  const dx = (x1 - x2) / 2; const dy = (y1 - y2) / 2;
  const x1p = cos * dx + sin * dy; const y1p = -sin * dx + cos * dy;
  rx = Math.abs(rx); ry = Math.abs(ry);
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) { rx *= Math.sqrt(lambda); ry *= Math.sqrt(lambda); }
  const sign = fa === fs ? -1 : 1;
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const coef = sign * Math.sqrt(Math.max(0, num / den));
  const cxp = coef * ((rx * y1p) / ry); const cyp = coef * (-(ry * x1p) / rx);
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2; const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const ang = (ux, uy, vx, vy) => {
    const a = Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy)))));
    return ux * vy - uy * vx < 0 ? -a : a;
  };
  const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!fs && dt > 0) dt -= 2 * Math.PI; else if (fs && dt < 0) dt += 2 * Math.PI;
  const segs = Math.ceil(Math.abs(dt) / (Math.PI / 2));
  const out = [];
  const d = dt / segs;
  const k = (4 / 3) * Math.tan(d / 4);
  let t = t1;
  for (let i = 0; i < segs; i++) {
    const c1 = Math.cos(t); const s1 = Math.sin(t); const c2 = Math.cos(t + d); const s2 = Math.sin(t + d);
    const p = (x, y) => [cos * rx * x - sin * ry * y + cx, sin * rx * x + cos * ry * y + cy];
    const [ax, ay] = p(c1 - k * s1, s1 + k * c1);
    const [bx, by] = p(c2 + k * s2, s2 - k * c2);
    const [ex, ey] = p(c2, s2);
    out.push([ax, ay, bx, by, ex, ey]);
    t += d;
  }
  return out;
}

function parsePath(d) {
  const toks = d.match(/[a-zA-Z]|-?(?:\d*\.\d+|\d+\.?)(?:e[-+]?\d+)?/g) ?? [];
  const out = [];
  let i = 0; let cmd = ''; let x = 0; let y = 0; let sx = 0; let sy = 0; let lcx = 0; let lcy = 0; let lqx = 0; let lqy = 0; let prev = '';
  const n = () => Number(toks[i++]);
  while (i < toks.length) {
    if (/[a-zA-Z]/.test(toks[i])) cmd = toks[i++];
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    switch (C) {
      case 'M': { const nx = n() + (rel ? x : 0); const ny = n() + (rel ? y : 0); x = nx; y = ny; sx = x; sy = y; out.push(['M', x, y]); cmd = rel ? 'l' : 'L'; break; }
      case 'L': { x = n() + (rel ? x : 0); y = n() + (rel ? y : 0); out.push(['L', x, y]); break; }
      case 'H': { x = n() + (rel ? x : 0); out.push(['L', x, y]); break; }
      case 'V': { y = n() + (rel ? y : 0); out.push(['L', x, y]); break; }
      case 'C': {
        const a = [n(), n(), n(), n(), n(), n()];
        if (rel) for (let j = 0; j < 6; j++) a[j] += j % 2 ? y : x;
        out.push(['C', ...a]); lcx = a[2]; lcy = a[3]; x = a[4]; y = a[5]; break;
      }
      case 'S': {
        const a = [n(), n(), n(), n()];
        if (rel) for (let j = 0; j < 4; j++) a[j] += j % 2 ? y : x;
        const [c1x, c1y] = /[CS]/.test(prev) ? [2 * x - lcx, 2 * y - lcy] : [x, y];
        out.push(['C', c1x, c1y, a[0], a[1], a[2], a[3]]); lcx = a[0]; lcy = a[1]; x = a[2]; y = a[3]; break;
      }
      case 'Q': case 'T': {
        let qx; let qy;
        if (C === 'Q') { qx = n() + (rel ? x : 0); qy = n() + (rel ? y : 0); } else { [qx, qy] = /[QT]/.test(prev) ? [2 * x - lqx, 2 * y - lqy] : [x, y]; }
        const ex = n() + (rel ? x : 0); const ey = n() + (rel ? y : 0);
        out.push(['C', x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), ex + (2 / 3) * (qx - ex), ey + (2 / 3) * (qy - ey), ex, ey]);
        lqx = qx; lqy = qy; x = ex; y = ey; break;
      }
      case 'A': {
        // Arc flags may be written without separators ("0 011.6 2" is flags 0, 1 then x 1.6): read them one digit at a time.
        const flag = () => { const t = toks[i]; if (t.length > 1 && /^[01]/.test(t)) { toks[i] = t.slice(1); return Number(t[0]); } i++; return Number(t); };
        const rx = n(); const ry = n(); const phi = n(); const fa = flag(); const fs = flag();
        const ex = n() + (rel ? x : 0); const ey = n() + (rel ? y : 0);
        for (const c of arcToCubics(x, y, rx, ry, phi, fa, fs, ex, ey)) out.push(['C', ...c]);
        x = ex; y = ey; break;
      }
      case 'Z': out.push(['Z']); x = sx; y = sy; break;
      default: throw new Error(`unknown path command ${cmd}`);
    }
    prev = C;
  }
  return out;
}

function ellipse(cx, cy, rx, ry) {
  const k = 0.5522847498;
  return [['M', cx + rx, cy],
    ['C', cx + rx, cy + k * ry, cx + k * rx, cy + ry, cx, cy + ry],
    ['C', cx - k * rx, cy + ry, cx - rx, cy + k * ry, cx - rx, cy],
    ['C', cx - rx, cy - k * ry, cx - k * rx, cy - ry, cx, cy - ry],
    ['C', cx + k * rx, cy - ry, cx + rx, cy - k * ry, cx + rx, cy], ['Z']];
}

function rect(x, y, w, h, rx = 0, ry = rx) {
  rx = Math.min(rx || ry || 0, w / 2); ry = Math.min(ry || rx || 0, h / 2);
  if (!rx) return [['M', x, y], ['L', x + w, y], ['L', x + w, y + h], ['L', x, y + h], ['Z']];
  const k = 0.5522847498;
  return [['M', x + rx, y], ['L', x + w - rx, y], ['C', x + w - rx + k * rx, y, x + w, y + ry - k * ry, x + w, y + ry],
    ['L', x + w, y + h - ry], ['C', x + w, y + h - ry + k * ry, x + w - rx + k * rx, y + h, x + w - rx, y + h],
    ['L', x + rx, y + h], ['C', x + rx - k * rx, y + h, x, y + h - ry + k * ry, x, y + h - ry],
    ['L', x, y + ry], ['C', x, y + ry - k * ry, x + rx - k * rx, y, x + rx, y], ['Z']];
}

function points(s, close) {
  const nums = (s.match(/-?(?:\d*\.\d+|\d+\.?)/g) ?? []).map(Number);
  const out = [];
  for (let i = 0; i + 1 < nums.length; i += 2) out.push([i ? 'L' : 'M', nums[i], nums[i + 1]]);
  if (close) out.push(['Z']);
  return out;
}

function commandsOf(el) {
  const [tag, a] = el;
  const num = (k, d = 0) => (a[k] === undefined ? d : Number(a[k]));
  switch (tag) {
    case 'path': return parsePath(a.d);
    case 'circle': return ellipse(num('cx'), num('cy'), num('r'), num('r'));
    case 'ellipse': return ellipse(num('cx'), num('cy'), num('rx'), num('ry'));
    case 'rect': return rect(num('x'), num('y'), num('width'), num('height'), num('rx', num('ry')), num('ry', num('rx')));
    case 'line': return [['M', num('x1'), num('y1')], ['L', num('x2'), num('y2')]];
    case 'polyline': return points(a.points, false);
    case 'polygon': return points(a.points, true);
    default: throw new Error(`unknown element ${tag}`);
  }
}

function serialise(cmds) {
  return cmds.map(([c, ...v]) => `${c}${v.map(fmt).join(' ')}`).join('');
}

const picked = [...new Set(CURATED)].filter(name => {
  if (nodes[name]) return true;
  console.warn(`  (no icon "${name}" in lucide-static ${version} — skipped)`);
  return false;
});
const lines = picked.map((name) => {
  const d = serialise(nodes[name].flatMap(commandsOf));
  const t = (tags[name] ?? []).filter(x => /^[a-z0-9 -]+$/i.test(x)).slice(0, 10).join(' ');
  return `  ${JSON.stringify(name)}: [${JSON.stringify(t)}, ${JSON.stringify(d)}],`;
});

const out = `/**
 * The deck icon set — ${picked.length} icons from Lucide ${version} (ISC; licence and the
 * Feather notice in ./LICENSE), each one normalised path in a 24×24 box.
 *
 * Generated by scripts/vendor-deck-icons.mjs — do not edit by hand. Paths
 * are absolute M/L/C/Z only so the editor's SVG and PowerPoint's native
 * freeform (a:custGeom) draw identical strokes; tags are Lucide's own, used
 * by keyword search (shared/ui/canvas/deck-icons.ts).
 *
 * @module shared/ui/canvas/vendor/lucide/icons
 */

/** name → [space-separated tags, path data]. Stroked, 2 units wide, round caps and joins. */
export const LUCIDE_ICONS: Record<string, [string, string]> = {
${lines.join('\n')}
};

export const LUCIDE_VERSION = ${JSON.stringify(version)};
`;
const dir = path.join(process.cwd(), 'shared', 'ui', 'canvas', 'vendor', 'lucide');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'icons.ts'), out.replace(/\r\n/g, '\n'));
fs.writeFileSync(path.join(dir, 'LICENSE'), fs.readFileSync(path.join(pkg, 'LICENSE'), 'utf8').replace(/\r\n/g, '\n'));
console.log(`wrote ${picked.length} icons (${Math.round(out.length / 1024)} KB) to ${path.relative(process.cwd(), dir)}`);
