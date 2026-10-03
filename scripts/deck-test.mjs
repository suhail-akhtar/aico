/**
 * AICO Slides, tested offline: the deck model (loose input normalised,
 * ECharts options converted, operations replayed over the agent's writes),
 * text measurement, the layout engine (fitting, shrinking, overflow and the
 * other problems the Canvas tool reports, every frame inside the slide in
 * every theme), the themes (scheme colours, PowerPoint's luminance maths,
 * measured fonts, deck types that name real themes and layouts), the .pptx
 * writer (every XML part well formed, every part typed, every relationship
 * resolving, title placeholders, native charts with an embedded workbook,
 * speaker notes, transitions, theme colours and fonts), and the Canvas tool
 * and routes for decks with their version checks.
 *
 * Why a script of its own: the deck code is shared (`shared/ui/canvas/deck-*`)
 * plus three engine modules, and the cases are many. Part of `npm test`. No
 * model, no network, no browser (a .pptx without diagrams needs none).
 */

// A store of this process's own — nothing below may touch ~/.aico. Must stay first.
import './lib/test-home.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';

import {
  DeckModel as M, DeckLayout as L, DeckThemes as T, DeckTypes as DT, DeckRender as R, deckTextWidth, toPptx, imageSize, nativeChart,
  runInContext, canvasTool, getCanvas, writeCanvas, handleCanvasRoute, canvasDefinition,
} from '../dist-test/test-exports.js';

let pass = 0; let fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 900)}` : ''}`); }
}
const errOf = async (fn) => { try { await fn(); return ''; } catch (e) { return e.message; } };

/** Well-formedness: balanced tags, quoted attributes, known entities. Enough to catch what makes Office repair a file. */
function xmlProblem(text) {
  const stack = [];
  const re = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>|<\?[^>]*\?>|<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const between = text.slice(last, m.index);
    if (/[<>]/.test(between)) return `stray < or > near ${JSON.stringify(text.slice(last, last + 80))}`;
    if (/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(between)) return `bad entity near ${JSON.stringify(between.slice(0, 80))}`;
    last = m.index + m[0].length;
    if (!m[2]) continue;
    if (m[1]) { const open = stack.pop(); if (open !== m[2]) return `</${m[2]}> closes <${open}>`; }
    else if (!m[4]) stack.push(m[2]);
  }
  if (/[<>]/.test(text.slice(last).trim())) return 'trailing markup';
  return stack.length ? `unclosed <${stack.at(-1)}>` : '';
}

// A 2×1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAEElEQVR4nGP4z8DAwMDAAAAD9QEBjfVXGwAAAABJRU5ErkJggg==', 'base64');

console.log('\n══ AICO Slides: the deck model ══');
{
  const s = M.normalizeSlide({
    layout: 'title+bullets', title: '  Why now  ', bullets: ['- First point', '  Sub-point', { text: 'Third', level: 0 }, '', 7],
  }, 's1');
  ok(s.layout === 'bullets' && s.title === 'Why now' && s.bullets.length === 3 && s.bullets[1].level === 1 && s.bullets[0].text === 'First point',
    'a layout alias, trimmed title, bullets as strings with "  " for a sub-point', s);
  const echarts = M.toChart({ xAxis: { type: 'category', data: ['Q1', 'Q2'] }, yAxis: {}, series: [{ type: 'bar', name: 'Rev', data: [1, 2] }, { type: 'bar', name: 'Cost', data: [3, 4], stack: 't' }] });
  ok(echarts.type === 'stacked' && echarts.categories.join() === 'Q1,Q2' && echarts.series[1].values.join() === '3,4', 'an ECharts bar option becomes a native (stacked) chart', echarts);
  const pie = M.toChart({ series: [{ type: 'pie', radius: ['40%', '70%'], data: [{ name: 'A', value: 3 }, { name: 'B', value: '1,200' }] }] });
  ok(pie.type === 'doughnut' && pie.series[0].values.join() === '3,1200', 'an ECharts pie with a hole is a doughnut; "1,200" is a number', pie);
  const hbar = M.toChart({ yAxis: { type: 'category', data: ['x', 'y'] }, xAxis: { type: 'value' }, series: [{ type: 'bar', data: [1, 2] }] });
  ok(hbar.type === 'bar', 'a category y-axis is a horizontal bar chart');
  const exotic = M.toChart({ series: [{ type: 'sankey', data: [] }] });
  ok(exotic.echarts && exotic.categories.length === 0, 'anything else is kept as an ECharts option (a picture in PowerPoint)');
  ok(M.toLayout('KPIs') === 'kpi' && M.toLayout('sideways thing') === undefined && M.toLayout('Section header') === 'section', 'layout names resolve, nonsense does not');
  ok(/layout "sideways"/.test(await errOf(() => M.normalizeSlide({ layout: 'sideways' }, 's1'))), 'an unknown layout is refused naming the layouts');
  const merged = M.normalizeSlide({ subtitle: null, notes: 'Say this' }, 's1', { id: 's1', layout: 'title', title: 'T', subtitle: 'S' });
  ok(merged.title === 'T' && merged.subtitle === undefined && merged.notes === 'Say this', 'an update keeps unnamed fields, null clears one', merged);
  const planned = { id: 's2', layout: 'bullets', title: 'Plan', intent: 'what it says' };
  ok(M.isPending(planned) && !M.isPending(M.normalizeSlide({ bullets: ['x'] }, 's2', planned)), 'a planned slide stops being planned when content arrives');
  ok(JSON.stringify(M.parseRuns('a **b** *c* d_e_ _f_')) === JSON.stringify([{ text: 'a ' }, { text: 'b', b: true }, { text: ' ' }, { text: 'c', i: true }, { text: ' d_e_ ' }, { text: 'f', i: true }]),
    '**bold** and *italic* runs; snake_case stays literal', M.parseRuns('a **b** *c* d_e_ _f_'));
  ok(JSON.stringify(M.parseRuns('run `git switch -c x` **now**')) === JSON.stringify([{ text: 'run ' }, { text: 'git switch -c x', c: true }, { text: ' ' }, { text: 'now', b: true }]),
    '`code` runs (models write commands in backticks)');
  ok(/is JSON/.test(await errOf(() => M.parseDeck('{nope'))) && /slides/.test(await errOf(() => M.parseDeck('{"v":1}'))), 'a deck that is not one is refused with why');

  let d = M.deckFrom({ v: 1, theme: 'slate', slides: [{ id: 's1', layout: 'title', title: 'A' }, { id: 's2', layout: 'bullets', title: 'B' }, { id: 's2', layout: 'bullets', title: 'dup id' }] });
  ok(d.slides.map(x => x.id).join() === 's1,s2,s2x', 'a duplicate slide id is made unique on parse');
  ok(M.nextSlideId(d) === 's3', 'the next id never reuses a gap');
  const mine = [{ op: 'set', slide: { ...d.slides[0], title: 'A (mine)' } }, { op: 'set', slide: { ...d.slides[1], title: 'B (mine)' } }];
  const agents = M.applyDeckOp(M.applyDeckOp(d, { op: 'delete', id: 's2' }), { op: 'insert', at: 3, slide: { id: 's9', layout: 'closing', title: 'Thanks' } });
  const re = M.replayDeck(agents, mine);
  ok(re.skipped === 1 && re.deck.slides[0].title === 'A (mine)' && re.deck.slides.some(x => x.id === 's9'), 'replay keeps my edit on s1 and the agent\'s new slide; my edit to the slide it deleted is skipped', re);
  d = M.applyDeckOp(d, { op: 'move', id: 's1', to: 2 });
  ok(d.slides.map(x => x.id).join() === 's2,s2x,s1', 'move');
  const dup = M.duplicateSlide(d, 's1');
  ok(dup.deck.slides.length === 4 && dup.slide.id === 's3' && dup.deck.slides[3].id === 's3', 'duplicate inserts a copy after it under a new id');
  ok(M.LAYOUTS.length === 17 && M.LAYOUTS.every(l => M.layoutInfo(l.id).id === l.id), 'seventeen layouts (ADR 0025 added infographic and image-grid)');
}

console.log('\n══ AICO Slides: measuring text ══');
{
  ok(deckTextWidth('WWWW', 'Segoe UI', 20) > deckTextWidth('iiii', 'Segoe UI', 20) * 2.5, 'per-glyph widths: W is far wider than i');
  ok(deckTextWidth('Revenue', 'Segoe UI', 20, true) > deckTextWidth('Revenue', 'Segoe UI', 20), 'bold is wider');
  ok(Math.abs(deckTextWidth('abc', 'Segoe UI', 40) - 2 * deckTextWidth('abc', 'Segoe UI', 20)) < 0.01, 'width scales with size');
  ok(deckTextWidth('Hello', 'No Such Font', 20) > deckTextWidth('Hello', 'Segoe UI', 20), 'an unknown font errs wide');
  ok(deckTextWidth('漢字', 'Arial', 10) === 20, 'CJK takes a full em');
  const fonts = new Set(T.DECK_THEMES.flatMap(t => [t.fonts.heading, t.fonts.body]));
  const missing = [...fonts].filter(f => deckTextWidth('Hello', f, 10) === deckTextWidth('Hello', 'No Such Font', 10));
  ok(missing.length === 0, 'every theme font has measured metrics', missing);
}

console.log('\n══ AICO Slides: themes and deck types ══');
{
  const ids = T.DECK_THEMES.map(t => t.id);
  ok(ids.length >= 12 && new Set(ids).size === ids.length, `${ids.length} themes, unique ids`);
  ok(T.DECK_THEMES.every(t => Object.values(t.scheme).every(h => /^#[0-9A-F]{6}$/i.test(h)) && Object.keys(t.scheme).length === 10), 'every theme has ten #RRGGBB scheme slots');
  const looks = new Set(T.DECK_THEMES.map(t => `${t.title}/${t.section}/${t.motif}/${t.fonts.heading}`));
  ok(looks.size === T.DECK_THEMES.length, 'no two themes share treatment, motif and heading font');
  const th = T.deckTheme('slate');
  ok(T.resolveHex({ ...th, scheme: { ...th.scheme, lt1: '#FFFFFF' } }, { s: 'lt1', mod: 0.5 }) === '#808080', 'lumMod 50% of white is mid grey (PowerPoint HSL)');
  ok(T.resolveHex(th, { s: 'dk1', mod: 0.12, off: 0.86 }) !== th.scheme.dk1 && T.cssColor(th, { s: 'accent1', a: 0.5 }).startsWith('rgba('), 'derived colours and alpha resolve for HTML');
  ok(T.deckTheme('nope').id === 'slate' && T.isDeckTheme('Boardroom') && !T.isDeckTheme('nope'), 'theme lookup by id or name, unknown falls back');
  const layoutIds = new Set(M.LAYOUTS.map(l => l.id));
  ok(DT.DECK_TYPES.length === 8 && DT.DECK_TYPES.every(t => T.isDeckTheme(t.theme) && t.slides.every(s => layoutIds.has(s.layout)) && t.slides[0].layout === 'title'),
    'eight deck types, each on a real theme, real layouts, opening with a title slide');
  ok(DT.deckTypeById('board pack')?.id === 'board-update' && DT.pickDeckType('Q3 board update')?.id === 'board-update' && DT.pickDeckType('Hello') === undefined,
    'deck types resolve by alias and from an obvious title');
}

console.log('\n══ AICO Slides: the layout engine ══');
{
  const deck = (slides, extra = {}) => ({ v: 1, aspect: '16:9', theme: 'slate', slides, ...extra });
  const short = L.layoutSlide(deck([{ id: 's1', layout: 'bullets', title: 'Three points', bullets: [{ text: 'One' }, { text: 'Two' }, { text: 'Three' }] }]), 0);
  const content = (l) => l.frames.find(f => f.name === 'Content');
  ok(short.problems.length === 0 && content(short).paras[0].size >= 24, 'short bullets fit at (or above) the design size', content(short).paras[0].size);
  const longText = 'This bullet is deliberately long so that the layout engine has to wrap it over several lines and then shrink it';
  const long = L.layoutSlide(deck([{ id: 's1', layout: 'bullets', title: 'Dense', bullets: Array.from({ length: 6 }, () => ({ text: longText })) }]), 0);
  ok(content(long).paras[0].size < 24 && content(long).paras[0].size >= 14 && !long.problems.some(p => /does not fit/.test(p.message)), 'dense bullets shrink to fit, above the floor', content(long).paras[0].size);
  const over = L.layoutSlide(deck([{ id: 's1', layout: 'bullets', title: 'Too much', bullets: Array.from({ length: 6 }, () => ({ text: `${longText} ${longText} ${longText} ${longText}` })) }]), 0);
  ok(over.problems.some(p => p.severity === 'error' && /does not fit even at 14 pt — cut about \d+ words/.test(p.message)) && content(over).overflow, 'text that cannot fit is drawn at the floor and reported with words to cut', over.problems);
  const many = L.layoutSlide(deck([{ id: 's1', layout: 'bullets', title: 'Many', bullets: Array.from({ length: 8 }, (_, i) => ({ text: `Point ${i}` })) }], { type: 'pitch' }), 0);
  ok(many.problems.some(p => /8 bullets — at most 4/.test(p.message)), 'too many bullets for the deck type (a pitch allows 4)', many.problems);
  const untitled = L.layoutSlide(deck([{ id: 's1', layout: 'chart', chart: { type: 'column', categories: [], series: [] } }]), 0);
  ok(untitled.problems.some(p => /no title/.test(p.message)) && untitled.problems.some(p => /no data/.test(p.message)), 'a missing title and an empty chart are reported');
  const mismatch = L.layoutSlide(deck([{ id: 's1', layout: 'chart', title: 'x', chart: { type: 'line', categories: ['a', 'b'], series: [{ name: 's', values: [1] }] } }]), 0);
  ok(mismatch.problems.some(p => /one value per category/.test(p.message)), 'series length must match the categories');
  const bigTable = L.layoutSlide(deck([{ id: 's1', layout: 'table', title: 'T', table: { header: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], rows: Array.from({ length: 12 }, () => ['x', 'y', 'z', 'w', 'v', 'u', 't']) } }]), 0);
  ok(bigTable.problems.some(p => /7 columns/.test(p.message)) && bigTable.problems.some(p => /12 rows/.test(p.message)), 'a table too big for a slide is reported');
  const kpis = L.layoutSlide(deck([{ id: 's1', layout: 'kpi', title: 'K', kpis: Array.from({ length: 5 }, (_, i) => ({ value: `${i}`, label: 'x' })) }]), 0);
  ok(kpis.problems.some(p => /5 KPIs/.test(p.message)), 'more than four big numbers is reported');
  const cols = L.layoutSlide(deck([{ id: 's1', layout: 'two-column', title: 'C', left: { heading: 'L', bullets: [{ text: 'short' }] }, right: { heading: 'R', bullets: Array.from({ length: 5 }, () => ({ text: longText })) } }]), 0);
  const c1 = cols.frames.find(f => f.name === 'Column 1').paras[0].size;
  const c2 = cols.frames.find(f => f.name === 'Column 2').paras[0].size;
  ok(c1 === c2, 'two columns share one text size', [c1, c2]);
  const titleLong = L.layoutSlide(deck([{ id: 's1', layout: 'bullets', title: longText.repeat(3), bullets: [{ text: 'x' }] }]), 0);
  ok(titleLong.problems.some(p => /title is too long/.test(p.message)), 'a title over two lines at the floor is reported');
  const plan = L.layoutSlide(deck([{ id: 's1', layout: 'chart', title: 'Traction', intent: 'growth over time' }]), 0, { draft: true });
  ok(plan.pending && plan.problems.length === 0 && plan.frames.some(f => f.name === 'Plan text'), 'a planned slide shows its plan in the editor and reports no content problems');
  const wide = L.layoutSlide(deck([{ id: 's1', layout: 'diagram', title: 'D', diagram: 'flowchart LR\n A-->B', bullets: [{ text: 'a' }, { text: 'b' }] }]), 0);
  ok(wide.frames.find(f => f.kind === 'diagram').w === 848 && wide.frames.some(f => f.name === 'Takeaway 2'), 'a left-to-right diagram takes the full width with its takeaways underneath');
  const chain = L.layoutSlide(deck([{ id: 's1', layout: 'diagram', title: 'D', diagram: 'flowchart LR\n A[a] --> B[b] --> C[c] --> D[d] --> E[e] --> F[f] --> G[g]' }]), 0);
  ok(chain.problems.some(p => /left-to-right flowchart 7 boxes long/.test(p.message)), 'a long left-to-right chain is reported as too wide to read', chain.problems);
  ok(L.flowRanks(['flowchart LR', '  U[Users] --> LB[LB]', '  LB --> W1[Web 1]', '  LB --> W2[Web 2]', '  W1 --> A1[App] --> SQL[(SQL)]',
    '  W2 --> A2[App] --> SQL', '  W1 -->|auth| ID[Entra]'].join('\n')) === 5,
    'a branching diagram is as wide as its longest chain, not its box count');
  const v = L.validateDeck(deck([{ id: 's1', layout: 'bullets', title: 'Same', bullets: [{ text: 'x' }] }, { id: 's2', layout: 'bullets', title: 'Same', bullets: [{ text: 'y' }] }]));
  ok(v.problems.some(p => /opens with a title slide/.test(p.message)) && v.problems.some(p => /2 slides are titled "same"/.test(p.message)), 'deck checks: no title slide, repeated titles');

  // Every layout × theme × aspect: text frames inside the slide, nothing NaN.
  const rich = (layout, id) => {
    const b = M.blankSlide(layout, id);
    return { ...b, title: b.title ?? 'Label', bullets: [{ text: 'A point' }, { text: 'Another point', level: 1 }], body: 'Body line', source: 'Source: test', notes: 'n',
      image: { src: 'x.png' }, quote: b.quote ?? 'Quote', attribution: 'Someone' };
  };
  const bad = [];
  for (const t of T.DECK_THEMES) {
    for (const aspect of ['16:9', '4:3']) {
      const d = deck(M.LAYOUTS.map((l, i) => rich(l.id, `s${i + 1}`)), { theme: t.id, aspect, footer: 'Footer' });
      for (const l of L.layoutDeck(d)) {
        for (const f of l.frames) {
          if ([f.x, f.y, f.w, f.h].some(n => !Number.isFinite(n))) bad.push(`${t.id} ${aspect} ${l.slide.layout} ${f.name} NaN`);
          if (f.kind === 'text' && (f.x < -0.5 || f.y < -0.5 || f.x + f.w > l.w + 0.5 || f.y + f.h > l.h + 0.5)) bad.push(`${t.id} ${aspect} ${l.slide.layout} ${f.name} outside`);
          if (f.kind === 'text' && f.overflow) bad.push(`${t.id} ${aspect} ${l.slide.layout} ${f.name} overflows`);
        }
      }
    }
  }
  ok(bad.length === 0, `every layout in all ${T.DECK_THEMES.length} themes and both shapes: text inside the slide, nothing overflowing`, bad.slice(0, 10));
  const html = R.slideHtml(L.layoutSlide(deck([{ id: 's1', layout: 'bullets', title: '<script>alert(1)</script>', bullets: [{ text: '"><img src=x onerror=alert(1)>' }] }]), 0), T.deckTheme('slate'));
  ok(!/<script>|<img src=x/.test(html) && html.includes('&lt;script&gt;'), 'the HTML renderer escapes slide text');
  ok(R.themedMermaid('flowchart LR\n A-->B', T.deckTheme('midnight')).startsWith('%%{init:') && R.themedMermaid('%%{init: {}}%%\nflowchart LR', th0()).startsWith('%%{init: {}}%%'),
    'Mermaid gets the theme as an init directive; an author\'s own directive wins');
  function th0() { return T.deckTheme('slate'); }
  const opt = R.deckChartOption({ type: 'column', categories: ['a'], series: [{ name: 's', values: [1] }], unit: '%' }, T.deckTheme('ember'));
  ok(opt.color[0] === T.deckTheme('ember').scheme.accent1 && opt.animation === false, 'charts use the theme palette, no animation');
}

console.log('\n══ AICO Slides: the PowerPoint writer ══');
{
  const slides = [
    { id: 's1', layout: 'title', title: 'Deck & <title>', subtitle: 'Sub', body: 'Presenter', notes: 'Opening line.\nSecond line & more.' },
    { id: 's2', layout: 'agenda', title: 'Agenda', bullets: [{ text: 'One' }, { text: 'Two' }] },
    { id: 's3', layout: 'section', title: 'Part one' },
    { id: 's4', layout: 'bullets', title: 'Bullets', bullets: [{ text: '**Bold** start' }, { text: 'Sub', level: 1 }], transition: 'fade', notes: 'Say it' },
    { id: 's5', layout: 'two-column', title: 'Cols', left: { heading: 'L', bullets: [{ text: 'a' }] }, right: { heading: 'R', bullets: [{ text: 'b' }] } },
    { id: 's6', layout: 'comparison', title: 'Cmp', left: { heading: 'L', bullets: [{ text: 'a' }] }, right: { heading: 'R', bullets: [{ text: 'b' }] } },
    { id: 's7', layout: 'image-text', title: 'Pic', image: { src: 'pic.png', alt: 'A picture' }, bullets: [{ text: 'x' }] },
    { id: 's8', layout: 'image', image: { src: 'missing.png' }, title: 'Caption' },
    { id: 's9', layout: 'chart', title: 'Chart', chart: { type: 'column', categories: ['Q1', 'Q2', '2026'], series: [{ name: 'Revenue', values: [1.5, 2, 3] }], unit: '£' } },
    { id: 's10', layout: 'chart', title: 'Pie', chart: { type: 'doughnut', categories: ['A', 'B'], series: [{ name: 'Share', values: [60, 40] }] } },
    { id: 's11', layout: 'chart', title: 'Lines', chart: { type: 'line', categories: ['a', 'b'], series: [{ name: 'x', values: [1, 2] }, { name: 'y', values: [2, 1] }] } },
    { id: 's12', layout: 'diagram', title: 'Diagram', diagram: 'flowchart LR\n A-->B' },
    { id: 's13', layout: 'table', title: 'Table', table: { header: ['A', 'B'], rows: [['1', '2'], ['3', '4']] } },
    { id: 's14', layout: 'kpi', title: 'KPIs', kpis: [{ value: '42%', label: 'Up', delta: '+3', trend: 'up' }] },
    { id: 's15', layout: 'quote', quote: 'Q', attribution: 'A' },
    { id: 's16', layout: 'timeline', title: 'Time', timeline: [{ date: '1', title: 'a' }, { date: '2', title: 'b' }] },
    { id: 's17', layout: 'closing', title: 'Thanks' },
  ];
  const deck = M.deckFrom({ v: 1, aspect: '16:9', theme: 'boardroom', footer: 'Footer', slides });
  const layouts = L.layoutDeck(deck);
  const size = imageSize(PNG);
  ok(size && size.width === 2 && size.height === 1 && size.ext === '.png', 'PNG size read from its header');
  const out = toPptx({ title: 'Test deck', deck, layouts, images: new Map([['pic.png', { bytes: PNG, ext: '.png', width: 2, height: 1 }], ['missing.png', undefined]]), pictures: new Map(), date: new Date('2026-10-03T00:00:00Z') });
  const files = unzipSync(out.bytes);
  const names = Object.keys(files);
  const text = (n) => strFromU8(files[n]);
  const xmlBad = names.filter(n => /\.(xml|rels)$/.test(n)).map(n => [n, xmlProblem(text(n))]).filter(([, p]) => p);
  ok(xmlBad.length === 0, `every one of ${names.filter(n => /\.(xml|rels)$/.test(n)).length} XML parts is well formed`, xmlBad.slice(0, 5));
  const ct = text('[Content_Types].xml');
  const untyped = names.filter(n => !n.endsWith('.rels') && n !== '[Content_Types].xml' && !ct.includes(`PartName="/${n}"`) && !ct.includes(`Extension="${n.split('.').pop()}"`));
  ok(untyped.length === 0, 'every part has a content type', untyped);
  const broken = [];
  for (const r of names.filter(n => n.endsWith('.rels'))) {
    const base = r.replace(/_rels\/[^/]*\.rels$/, '');
    for (const m of text(r).matchAll(/Target="([^"]+)"/g)) {
      const target = path.posix.normalize(path.posix.join(base, m[1])).replace(/^\//, '');
      if (!files[target]) broken.push(`${r} → ${m[1]}`);
    }
  }
  ok(broken.length === 0, 'every relationship resolves to a part in the package', broken);
  const pres = text('ppt/presentation.xml');
  const sldIds = [...pres.matchAll(/<p:sldId id="(\d+)"/g)].map(m => m[1]);
  ok(sldIds.length === slides.length && new Set(sldIds).size === sldIds.length && /<p:sldSz cx="12192000" cy="6858000"\/>/.test(pres), '17 slides with unique ids on a 13.33×7.5 in widescreen page');
  const slideXml = (n) => text(`ppt/slides/slide${n}.xml`);
  ok(slideXml(1).includes('<p:ph type="ctrTitle"/>') && slideXml(4).includes('<p:ph type="title"/>') && slideXml(4).includes('<p:ph idx="1"/>'), 'titles are title placeholders; bullets are the body placeholder');
  ok(slideXml(1).includes('Deck &amp; &lt;title&gt;') && !/<a:t>[^<]*<[^/]/.test(slideXml(1)), 'text is escaped');
  ok(/<a:buChar char="•"\/>/.test(slideXml(4)) && /<a:lnSpc><a:spcPts val="\d+"\/><\/a:lnSpc>/.test(slideXml(4)) && /lIns="0" tIns="0" rIns="0" bIns="0"/.test(slideXml(4)) && /<a:normAutofit\/>/.test(slideXml(4)),
    'native bullets, exact line pitch, zero insets, autofit for later edits');
  ok(/<a:latin typeface="\+mj-lt"\/>/.test(slideXml(4)) && /<a:schemeClr val="tx2"/.test(slideXml(4)) && /<a:schemeClr val="accent1"/.test(slideXml(4)), 'runs use theme fonts and scheme colours (Design tab variants restyle the deck)');
  const codeDeck = M.deckFrom({ v: 1, theme: 'slate', slides: [{ id: 's1', layout: 'bullets', title: 'T', bullets: ['run `git log`'] }] });
  const codeXml = strFromU8(unzipSync(toPptx({ title: 'c', deck: codeDeck, layouts: L.layoutDeck(codeDeck), images: new Map(), pictures: new Map() }).bytes)['ppt/slides/slide1.xml']);
  ok(/<a:latin typeface="Consolas"\/><a:cs typeface="Consolas"\/><\/a:rPr><a:t>git log<\/a:t>/.test(codeXml), 'inline code is set in Consolas in PowerPoint too');
  ok(/<p:transition spd="med"><p:fade\/><\/p:transition>/.test(slideXml(4)) && !/<p:transition/.test(slideXml(3)), 'a fade transition only where set');
  const theme = text('ppt/theme/theme1.xml');
  const bt = T.deckTheme('boardroom');
  ok(theme.includes(`<a:accent1><a:srgbClr val="${bt.scheme.accent1.slice(1)}"/>`) && theme.includes(`<a:majorFont><a:latin typeface="${bt.fonts.heading}"/>`) && theme.includes(`<a:minorFont><a:latin typeface="${bt.fonts.body}"/>`),
    'the theme part carries the deck theme\'s colours and fonts');
  ok(names.filter(n => /^ppt\/slideLayouts\/slideLayout\d\.xml$/.test(n)).length === 5 && text('ppt/slideMasters/slideMaster1.xml').includes('<p:sldLayoutIdLst>'), 'a master with five layouts');
  const s1rels = text('ppt/slides/_rels/slide1.xml.rels');
  ok(/notesSlide1\.xml/.test(s1rels) && text('ppt/notesSlides/notesSlide1.xml').includes('Second line &amp; more.') && !files['ppt/notesSlides/notesSlide2.xml'] && files['ppt/notesSlides/notesSlide4.xml'] && /<Notes>2<\/Notes>/.test(text('docProps/app.xml')),
    'speaker notes as notes slides (only where there are notes), one paragraph per line');
  const s9 = slideXml(9);
  const chartRel = /Target="\.\.\/charts\/(chart\d+\.xml)"/.exec(text('ppt/slides/_rels/slide9.xml.rels'))?.[1];
  const chart = chartRel && text(`ppt/charts/${chartRel}`);
  ok(/graphicData uri="http:\/\/schemas.openxmlformats.org\/drawingml\/2006\/chart"/.test(s9) && chart && /<c:barChart><c:barDir val="col"\/>/.test(chart)
    && chart.includes('<c:v>1.5</c:v>') && chart.includes('<c:v>2026</c:v>') && /<c:externalData r:id="rId1">/.test(chart), 'a column chart is a native chart with cached values', chartRel);
  const wbRel = text(`ppt/charts/_rels/${chartRel}.rels`);
  const wb = /Target="\.\.\/embeddings\/([^"]+)"/.exec(wbRel)?.[1];
  const book = wb && unzipSync(files[`ppt/embeddings/${wb}`]);
  ok(book && strFromU8(book['xl/worksheets/sheet1.xml']).includes('Revenue') && /'?2026/.test(strFromU8(book['xl/worksheets/sheet1.xml'])), 'its data is an embedded workbook (Edit Data works)');
  const pieChart = text(`ppt/charts/${/charts\/(chart\d+\.xml)/.exec(text('ppt/slides/_rels/slide10.xml.rels'))[1]}`);
  ok(/<c:doughnutChart>/.test(pieChart) && (pieChart.match(/<c:dPt>/g) ?? []).length === 2 && /<c:holeSize val="58"\/>/.test(pieChart), 'a doughnut colours each slice from the theme');
  ok(/<c:lineChart>/.test(text(`ppt/charts/${/charts\/(chart\d+\.xml)/.exec(text('ppt/slides/_rels/slide11.xml.rels'))[1]}`)) && /<c:legend>/.test(text(`ppt/charts/${/charts\/(chart\d+\.xml)/.exec(text('ppt/slides/_rels/slide11.xml.rels'))[1]}`)), 'a two-series line chart, with a legend');
  ok(/<p:pic>/.test(slideXml(7)) && /descr="A picture"/.test(slideXml(7)) && files['ppt/media/image1.png'] && /<a:srcRect /.test(slideXml(7)), 'a picture is embedded, cropped to cover its frame, with alt text');
  ok(!/<p:pic>/.test(slideXml(8)) && slideXml(8).includes('Image') && out.warnings.some(w => /missing\.png/.test(w)), 'a picture that cannot be read is a labelled placeholder and a warning');
  ok(!/<p:pic>/.test(slideXml(12)) && slideXml(12).includes('Diagram') && out.warnings.some(w => /Diagram/.test(w)), 'without a browser a diagram is a placeholder, and the result says so');
  ok(/<a:tbl>/.test(slideXml(13)) && (slideXml(13).match(/<a:tc>/g) ?? []).length === 6 && /<a:lnB w="9525"/.test(slideXml(13)), 'a native table: 3×2 cells with rules');
  ok(nativeChart(slides[8].chart) && !nativeChart({ type: 'column', categories: [], series: [], echarts: {} }), 'native chart test');
  const four = toPptx({ title: 'x', deck: { ...deck, aspect: '4:3' }, layouts: L.layoutDeck({ ...deck, aspect: '4:3' }), images: new Map(), pictures: new Map([[R.diagramKey('flowchart LR\n A-->B', T.deckTheme('boardroom')), { png: PNG, width: 2, height: 1 }]]) });
  const fz = unzipSync(four.bytes);
  ok(/type="screen4x3"/.test(strFromU8(fz['ppt/presentation.xml'])) && /<p:pic>/.test(strFromU8(fz['ppt/slides/slide12.xml'])), '4:3 decks; a rendered diagram is placed as a picture');
}

console.log('\n══ AICO Slides: the Canvas tool and routes ══');
{
  const project = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'aico-decks-test-')));
  fs.writeFileSync(path.join(project, 'pic.png'), PNG);
  const sid = 'deck-session';
  const settings = {};
  const tool = (input) => runInContext({ cwd: project, sessionId: sid, settings }, () => canvasTool(input));
  const def = canvasDefinition;
  ok(def.inputSchema.properties.kind.enum.includes('deck') && def.inputSchema.properties.action.enum.includes('set_slides') && /Decks \(kind "deck"/.test(def.description), 'the Canvas tool advertises decks');
  const made = await tool({ action: 'create', kind: 'deck', title: 'Q3 board update', footer: 'Acme' });
  const id = /deck canvas (cv-[0-9a-f]+)/.exec(made)?.[1];
  ok(id && /Picked deck type "board-update"/.test(made) && /Still planned/.test(made) && /```canvas\n\{"id":"cv-/.test(made) && /Brief \(Board update\)/.test(made), 'create plans the deck from the type the title names, with its brief and a card', made.slice(0, 400));
  const doc = await getCanvas({ settings, cwd: project, sessionId: sid }, id);
  const deck = M.parseDeck(doc.content);
  ok(doc.kind === 'deck' && deck.theme === 'boardroom' && deck.type === 'board-update' && deck.slides.every(s => s.intent), 'stored as a deck canvas on the type\'s theme, every slide planned');
  ok(/needs a layout/.test(await errOf(() => tool({ action: 'set_slides', id, version: 1, slides: [{ title: 'no layout' }] }))), 'a new slide needs a layout');
  ok(/NOT APPLIED — deck cv-.* is at version 1, not 7/.test(await errOf(() => tool({ action: 'set_slides', id, version: 7, slides: [{ id: 's1', title: 'x' }] }))), 'a stale version is refused with the current outline');
  const filled = await tool({ action: 'set_slides', id, version: 1, slides: [
    { id: 's1', title: 'Q3 board update', subtitle: 'Acme', notes: 'Hello' },
    { id: 's2', bullets: Array.from({ length: 7 }, (_, i) => `Point ${i + 1}`) },
    { id: 's3', layout: 'kpi', kpis: [{ value: '£4.2m', label: 'Revenue', delta: '+12%' }] },
    { layout: 'image-text', title: 'Picture', image: { src: 'pic.png' }, bullets: ['x'], at: 4 },
  ] });
  ok(/now version 2/.test(filled) && /FIX s2 \(slide 2\) bullets: 7 bullets — at most 5/.test(filled) && /added s9/.test(filled), 'set_slides fills, adds at a position, and returns the layout check with FIX lines', filled.slice(0, 900));
  const read = await tool({ action: 'read', id });
  ok(/1\. s1 \[title\] "Q3 board update"/.test(read) && /4\. s9 \[image-text\]/.test(read) && /Still planned/.test(read), 'read is one line per slide plus the check', read.slice(0, 500));
  const full = await tool({ action: 'read', id, slides: ['s3'] });
  ok(/"value": "£4.2m"/.test(full) && /"trend": "up"/.test(full), 'read with slide ids returns their fields');
  const fixed = await tool({ action: 'set_slides', id, version: 2, slides: [{ id: 's2', bullets: ['One', 'Two', 'Three'] }], remove: ['s8'], order: undefined, theme: 'forest' });
  ok(/now version 3/.test(fixed) && !/FIX s2/.test(fixed) && /removed s8/.test(fixed) && /theme forest/.test(fixed), 'a fix clears the problem; remove and theme in the same write');
  ok(/order must list every slide id/.test(await errOf(() => tool({ action: 'set_slides', id, version: 3, order: ['s1'] }))), 'order must be a full permutation');
  ok(/is a deck — change it with set_slides/.test(await errOf(() => tool({ action: 'edit', id, version: 3, find: 'a', replace: 'b' }))), 'document edits on a deck point at set_slides');
  ok(/not a deck/.test(await errOf(() => writeCanvas({ settings, cwd: project, sessionId: sid }, id, { content: '{"bad":1}', baseVersion: 3, author: 'user' }))), 'the store refuses a write that is not a deck');
  const exp = await tool({ action: 'export', id, format: 'pptx', path: 'out/board.pptx' });
  const pptx = path.join(project, 'out', 'board.pptx');
  ok(/as pptx/.test(exp) && fs.existsSync(pptx) && unzipSync(new Uint8Array(fs.readFileSync(pptx)))['ppt/media/image1.png'], 'export pptx writes the file with the project picture embedded', exp);
  ok(/A deck exports as pptx, pdf, png/.test(await errOf(() => tool({ action: 'export', id, format: 'docx' }))), 'a deck refuses document formats');

  const call = async (route, { method = 'GET', query = {}, body } = {}) => {
    const url = new URL(`http://x/api/${route}?${new URLSearchParams({ session: sid, ...query })}`);
    const out = { status: 0, body: undefined, headers: {}, bytes: undefined };
    const res = { writeHead(s, h) { out.status = s; out.headers = h; }, end(b) { out.bytes = b; } };
    await handleCanvasRoute(route, { method, headers: {} }, res, url, {
      resolveCwd: async () => project, readJson: async () => ({ session: sid, ...body }), send: (_r, s, b) => { out.status = s; out.body = b; },
    });
    return out;
  };
  const mk = await call('canvas/create', { method: 'POST', body: { title: 'Blank deck', kind: 'deck', content: '' } });
  ok(mk.status === 200 && mk.body.canvas.kind === 'deck' && M.parseDeck(mk.body.canvas.content).slides.length === 0, 'canvas/create kind deck starts an empty deck');
  const pp = await call(`canvas/${id}/export`, { query: { format: 'pptx' } });
  ok(pp.status === 200 && /presentationml/.test(pp.headers['Content-Type']) && /q3-board-update\.pptx/.test(pp.headers['Content-Disposition']) && pp.bytes.length > 5000, 'the export route serves the .pptx');
  const ppBad = await call(`canvas/${id}/export`, { query: { format: 'xlsx' } });
  ok(ppBad.status === 400 && /pptx, pdf, png/.test(ppBad.body.error), 'and refuses a sheet format');
  const tabs = await call('canvas/tabs', { method: 'POST', body: { id, op: 'add', title: 'x' } });
  ok(tabs.status === 400 && /add a slide/.test(tabs.body.error), 'a deck has no document tabs');
}

console.log(`\nDecks: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
