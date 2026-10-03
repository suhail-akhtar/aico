/**
 * Slides as HTML — the one renderer behind the deck editor's canvas and
 * thumbnails, present mode, and the PDF and PNG exports.
 *
 * It draws the layout engine's frames (`deck-layout.ts`) and makes no layout
 * decision of its own: every box is absolutely positioned in points, every
 * paragraph has the size and exact line pitch the engine fitted, so what the
 * person edits is what Chrome prints and what PowerPoint shows. It is a
 * string renderer (no React) because the engine prints PDFs in Node; the
 * editor sets the same string as a slide's inner HTML. Every piece of
 * content is escaped here — slide text comes from the model and the person,
 * and a `<script>` in a bullet must stay a bullet.
 *
 * Charts and diagrams are drawn elsewhere (ECharts SSR, Mermaid) into SVG and
 * handed in through `visual`; this module supplies what both need to look
 * like the deck: {@link deckChartOption} (the theme's palette, fonts and
 * gridlines) and {@link themedMermaid} (an `%%{init}%%` directive with the
 * theme's colours, so no global Mermaid configuration is touched).
 *
 * @module shared/ui/canvas/deck-render
 */

import type { DeckChart } from './deck-model';
import type { Color, Frame, Para, SlideLayout, TableFrame, TextFrame } from './deck-layout';
import { chartPalette, cssColor, cssFont, resolveHex, roles, type ColorRef, type DeckTheme } from './deck-themes';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** A short stable hash (FNV-1a), for caching drawn visuals by source. */
export function hashKey(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

export function chartKey(chart: DeckChart, theme: DeckTheme, w: number, h: number): string {
  return `c${hashKey(`${theme.id}|${Math.round(w)}x${Math.round(h)}|${JSON.stringify(chart)}`)}`;
}

export function diagramKey(source: string, theme: DeckTheme): string {
  return `d${hashKey(`${theme.id}|${source}`)}`;
}

/** The base CSS every rendered slide needs (inlined in exports, injected once in the app). */
export const DECK_SLIDE_CSS = `
.dk-slide { position: relative; overflow: hidden; box-sizing: border-box; -webkit-font-smoothing: antialiased; text-rendering: geometricPrecision; font-kerning: none; }
.dk-slide * { box-sizing: border-box; }
.dk-t { position: absolute; display: flex; flex-direction: column; overflow: visible; }
.dk-t p, .dk-tb p { margin: 0; padding: 0; position: relative; overflow-wrap: break-word; white-space: normal; }
.dk-bu { position: absolute; top: 0; }
.dk-slide code { font-family: Consolas, "Cascadia Code", Menlo, monospace; font-size: 1em; background: none; padding: 0; color: inherit; }
.dk-s, .dk-i, .dk-v, .dk-tb { position: absolute; }
.dk-i { overflow: hidden; }
.dk-i img { width: 100%; height: 100%; display: block; }
.dk-v { display: flex; align-items: center; justify-content: center; }
.dk-v svg { width: 100%; height: 100%; display: block; }
.dk-v img { max-width: 100%; max-height: 100%; }
.dk-ph { border-radius: 6pt; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4pt; font: 12pt "Segoe UI", sans-serif; text-align: center; padding: 12pt; }
.dk-ph code { font: 9pt Consolas, monospace; opacity: 0.75; white-space: pre-wrap; max-height: 60%; overflow: hidden; }
.dk-tb table { border-collapse: collapse; table-layout: fixed; width: 100%; }
.dk-tb td { overflow: hidden; vertical-align: middle; }
.dk-over { outline: 2px dashed #DC2626; outline-offset: 1px; }
`;

export interface RenderOptions {
  /** SVG (or an `<img>`) for a chart or diagram frame, by key; absent = a placeholder. */
  visual?: (key: string) => string | undefined;
  /** A loadable URL for an image src (data URL, served file); absent = a labelled placeholder. */
  image?: (src: string) => string | undefined;
  /** Mark frames whose text overflows (the editor). */
  showOverflow?: boolean;
  /** Add data-field attributes (the editor maps clicks to fields). */
  fields?: boolean;
}

function col(theme: DeckTheme, c: Color | undefined): string {
  return c === undefined ? 'transparent' : cssColor(theme, c);
}

function paraHtml(p: Para, theme: DeckTheme): string {
  const font = cssFont(p.font === 'h' ? theme.fonts.heading : theme.fonts.body);
  const style = [
    `font-family:${esc(font)}`, `font-size:${p.size}pt`, `line-height:${p.lh}pt`, `color:${col(theme, p.color)}`,
    `font-weight:${p.bold ? 700 : 400}`, ...(p.italic ? ['font-style:italic'] : []),
    `text-align:${p.align === 'c' ? 'center' : p.align === 'r' ? 'right' : 'left'}`,
    ...(p.indent ? [`padding-left:${p.indent}pt`] : []), ...(p.before ? [`margin-top:${p.before}pt`] : []),
    ...(p.caps ? ['text-transform:uppercase'] : []), ...(p.tracking ? [`letter-spacing:${p.tracking}pt`] : []),
  ].join(';');
  const hang = Math.min(p.indent, Math.round(p.size * 1.1));
  const bullet = p.bullet
    ? `<span class="dk-bu" style="left:${p.indent - hang}pt;color:${col(theme, p.bulletColor ?? p.color)}">${esc(p.bullet)}</span>` : '';
  const runs = p.runs.map((r) => {
    if (r.br) return '<br>';
    let t = esc(r.text);
    if (r.c) t = `<code>${t}</code>`;
    if (r.b && !p.bold) t = `<b>${t}</b>`;
    if (r.i && !p.italic) t = `<i>${t}</i>`;
    if (r.color) t = `<span style="color:${col(theme, r.color)}">${t}</span>`;
    return t;
  }).join('');
  return `<p style="${style}">${bullet}${runs || '&#8203;'}</p>`;
}

function box(f: { x: number; y: number; w: number; h: number }): string {
  return `left:${f.x}pt;top:${f.y}pt;width:${f.w}pt;height:${f.h}pt`;
}

function fieldAttr(field: string | undefined, opts: RenderOptions): string {
  return opts.fields && field ? ` data-field="${esc(field)}"` : '';
}

function textHtml(f: TextFrame, theme: DeckTheme, opts: RenderOptions): string {
  const justify = f.anchor === 'm' ? 'center' : f.anchor === 'b' ? 'flex-end' : 'flex-start';
  const over = opts.showOverflow && f.overflow ? ' dk-over' : '';
  return `<div class="dk-t${over}"${fieldAttr(f.field, opts)} style="${box(f)};justify-content:${justify}">${f.paras.map(p => paraHtml(p, theme)).join('')}</div>`;
}

function tableHtml(f: TableFrame, theme: DeckTheme, opts: RenderOptions): string {
  const line = col(theme, f.line);
  const rows = f.cells.map((row, ri) => `<tr style="height:${f.rows[ri]}pt">${row.map(cell => (
    `<td style="padding:${f.pad.y}pt ${f.pad.x}pt;border-bottom:0.75pt solid ${line};${cell.fill ? `background:${col(theme, cell.fill)}` : ''}">${cell.paras.map(p => paraHtml(p, theme)).join('')}</td>`
  )).join('')}</tr>`).join('');
  const over = opts.showOverflow && f.overflow ? ' dk-over' : '';
  return `<div class="dk-tb${over}"${fieldAttr(f.field, opts)} style="${box(f)}"><table><colgroup>${f.cols.map(w => `<col style="width:${w}pt">`).join('')}</colgroup><tbody>${rows}</tbody></table></div>`;
}

function placeholder(theme: DeckTheme, label: string, detail?: string): string {
  const r = roles(theme);
  return `<div class="dk-ph" style="width:100%;height:100%;background:${cssColor(theme, r.surface)};color:${cssColor(theme, r.muted)}">`
    + `<div>${esc(label)}</div>${detail ? `<code>${esc(detail.slice(0, 300))}</code>` : ''}</div>`;
}

function frameHtml(f: Frame, theme: DeckTheme, opts: RenderOptions): string {
  switch (f.kind) {
    case 'text': return textHtml(f, theme, opts);
    case 'table': return tableHtml(f, theme, opts);
    case 'shape': {
      const s: string[] = [box(f)];
      if (f.fill !== undefined) s.push(`background:${col(theme, f.fill)}`);
      if (f.gradient) {
        const c0 = cssColor(theme, { ...f.gradient, a: 0 });
        const c1 = cssColor(theme, f.gradient);
        s.push(`background:linear-gradient(to bottom, ${c0}, ${c1})`);
      }
      if (f.line) s.push(`border:${f.line.w}pt ${f.line.dash ? 'dashed' : 'solid'} ${col(theme, f.line.color)}`);
      if (f.geom === 'ellipse') s.push('border-radius:50%');
      else if (f.geom === 'roundRect') s.push(`border-radius:${f.radius ?? 8}pt`);
      else if (f.geom === 'topRound') s.push(`border-radius:${f.radius ?? 8}pt ${f.radius ?? 8}pt 0 0`);
      else if (f.geom === 'corner') s.push('clip-path:polygon(0 0,100% 0,100% 100%)');
      return `<div class="dk-s"${fieldAttr(f.field, opts)} style="${s.join(';')}"></div>`;
    }
    case 'image': {
      const url = opts.image?.(f.src);
      const inner = url
        ? `<img src="${esc(url)}" alt="${esc(f.alt)}" style="object-fit:${f.fit}">`
        : placeholder(theme, f.alt ? `Image: ${f.alt}` : 'Image', f.src.startsWith('data:') ? undefined : f.src);
      return `<div class="dk-i"${fieldAttr(f.field, opts)} style="${box(f)}">${inner}</div>`;
    }
    case 'chart': {
      const v = opts.visual?.(chartKey(f.chart, theme, f.w, f.h));
      return `<div class="dk-v"${fieldAttr(f.field, opts)} style="${box(f)}">${v ?? placeholder(theme, 'Chart')}</div>`;
    }
    case 'diagram': {
      const v = opts.visual?.(diagramKey(f.source, theme));
      return `<div class="dk-v"${fieldAttr(f.field, opts)} style="${box(f)}">${v ?? placeholder(theme, 'Diagram', f.source)}</div>`;
    }
  }
}

/** One slide as an HTML fragment: a `div.dk-slide` of `w`×`h` points. */
export function slideHtml(layout: SlideLayout, theme: DeckTheme, opts: RenderOptions = {}): string {
  return `<div class="dk-slide" data-slide="${esc(layout.slide.id)}" style="width:${layout.w}pt;height:${layout.h}pt;background:${col(theme, layout.background)}">`
    + layout.frames.map(f => frameHtml(f, theme, opts)).join('') + '</div>';
}

// ── Charts and diagrams in the deck's look ───────────────────────────

/** An ECharts option for a deck chart, `w`×`h` points, in the theme's palette and fonts. */
export function deckChartOption(chart: DeckChart, theme: DeckTheme): Record<string, unknown> {
  const r = roles(theme);
  const palette = chartPalette(theme);
  const text = cssColor(theme, r.text);
  const muted = cssColor(theme, r.muted);
  const line = cssColor(theme, r.line);
  // Unquoted: ECharts writes the family into an SVG attribute, where a quoted list fell back to a serif face.
  const font = `${theme.fonts.body}, ${theme.fonts.body === 'Segoe UI' ? '' : 'Segoe UI, '}Arial, sans-serif`;
  const base = { animation: false, color: palette, textStyle: { fontFamily: font, color: text, fontSize: 17 }, backgroundColor: 'transparent' };
  if (chart.echarts) return { ...chart.echarts, ...base };
  const unit = chart.unit ?? '';
  const fmt = (v: number): string => {
    const n = Math.abs(v) >= 1000 ? v.toLocaleString('en-GB', { maximumFractionDigits: 0 }) : String(Math.round(v * 100) / 100);
    return unit === '%' ? `${n}%` : unit && /^[£$€¥₹]/.test(unit) ? `${unit}${n}` : unit ? `${n} ${unit}` : n;
  };
  // Axis ticks carry only % and currency; a word unit ("ms") on every tick is noise — the labels and the title carry it.
  const tick = (v: number): string => (unit === '%' || /^[£$€¥₹]/.test(unit) ? fmt(v) : fmt(v).replace(` ${unit}`, ''));
  const multi = chart.series.length > 1;
  const legend = { bottom: 0, icon: 'roundRect', itemWidth: 16, itemHeight: 11, textStyle: { color: text, fontSize: 17, fontFamily: font } };
  if (chart.type === 'pie' || chart.type === 'doughnut') {
    const s = chart.series[0] ?? { name: '', values: [] };
    return {
      ...base,
      series: [{
        type: 'pie', radius: chart.type === 'doughnut' ? ['46%', '72%'] : ['0%', '70%'], center: ['50%', '50%'],
        itemStyle: { borderColor: cssColor(theme, r.bg), borderWidth: 2 },
        label: { color: text, fontSize: 17, fontFamily: font, formatter: (p: { name: string; percent: number }) => `${p.name}\n${Math.round(p.percent)}%` },
        labelLine: { lineStyle: { color: muted } },
        data: chart.categories.map((c, i) => ({ name: c, value: s.values[i] ?? 0 })),
      }],
    };
  }
  const horizontal = chart.type === 'bar';
  const cat = { type: 'category', data: chart.categories, axisLine: { lineStyle: { color: line } }, axisTick: { show: false }, axisLabel: { color: muted, fontSize: 16, fontFamily: font } };
  const val = {
    type: 'value', axisLine: { show: false }, axisTick: { show: false }, splitLine: { lineStyle: { color: line } },
    axisLabel: { color: muted, fontSize: 16, fontFamily: font, formatter: (v: number) => tick(v) },
  };
  const labels = !multi && chart.categories.length <= 10 && chart.type !== 'line' && chart.type !== 'area';
  return {
    ...base,
    grid: { left: 8, right: 18, top: 30, bottom: multi ? 46 : 8, containLabel: true },
    ...(multi ? { legend } : {}),
    xAxis: horizontal ? val : cat,
    yAxis: horizontal ? { ...cat, inverse: true } : val,
    series: chart.series.map((s) => {
      if (chart.type === 'line' || chart.type === 'area') {
        return {
          type: 'line', name: s.name, data: s.values, symbol: 'circle', symbolSize: 9, lineStyle: { width: 3.5 }, smooth: false,
          ...(chart.type === 'area' ? { areaStyle: { opacity: 0.18 } } : {}),
        };
      }
      return {
        type: 'bar', name: s.name, data: s.values, barMaxWidth: 56, ...(chart.type === 'stacked' ? { stack: 'total' } : {}),
        itemStyle: { borderRadius: theme.radius ? (horizontal ? [0, 3, 3, 0] : [3, 3, 0, 0]) : 0 },
        ...(labels ? { label: { show: true, position: horizontal ? 'right' : 'top', color: text, fontSize: 16, fontFamily: font, formatter: (p: { value: number }) => fmt(p.value) } } : {}),
      };
    }),
  };
}

/** Mermaid source with the theme's colours and font as an init directive (a directive already there wins). */
export function themedMermaid(source: string, theme: DeckTheme): string {
  if (/^\s*%%\{\s*init/.test(source)) return source;
  const r = roles(theme);
  const hex = (c: ColorRef): string => resolveHex(theme, c);
  const dark = theme.dark;
  const vars = {
    fontFamily: theme.fonts.body,
    fontSize: '18px',
    background: hex(r.bg),
    primaryColor: dark ? hex({ s: 'dk2', off: 0.1 }) : hex({ s: 'lt2' }),
    primaryBorderColor: hex(r.accent),
    primaryTextColor: hex(r.text),
    secondaryColor: dark ? hex({ s: 'dk2', off: 0.16 }) : hex({ s: 'accent2', mod: 0.2, off: 0.8 }),
    secondaryBorderColor: hex(r.accent2),
    secondaryTextColor: hex(r.text),
    tertiaryColor: dark ? hex({ s: 'dk2', off: 0.05 }) : hex({ s: 'lt1' }),
    tertiaryBorderColor: hex(r.line),
    tertiaryTextColor: hex(r.text),
    lineColor: hex(r.muted),
    textColor: hex(r.text),
    mainBkg: dark ? hex({ s: 'dk2', off: 0.1 }) : hex({ s: 'lt2' }),
    nodeBorder: hex(r.accent),
    clusterBkg: dark ? hex({ s: 'dk2', off: 0.04 }) : hex({ s: 'accent1', mod: 0.12, off: 0.9 }),
    clusterBorder: hex(r.line),
    edgeLabelBackground: hex(r.bg),
    titleColor: hex(r.title),
    actorBkg: dark ? hex({ s: 'dk2', off: 0.1 }) : hex({ s: 'lt2' }),
    actorBorder: hex(r.accent),
    actorTextColor: hex(r.text),
    signalColor: hex(r.text),
    noteBkgColor: dark ? hex({ s: 'dk2', off: 0.16 }) : hex({ s: 'accent2', mod: 0.3, off: 0.7 }),
    // Every text colour the export page's (light) base theme sets, or a dark deck's labels come out dark on dark.
    nodeTextColor: hex(r.text),
    signalTextColor: hex(r.text),
    labelTextColor: hex(r.text),
    loopTextColor: hex(r.text),
    noteTextColor: hex(r.text),
    noteBorderColor: hex(r.accent2),
    labelColor: hex(r.text),
    labelBoxBkgColor: dark ? hex({ s: 'dk2', off: 0.1 }) : hex({ s: 'lt2' }),
    labelBoxBorderColor: hex(r.line),
    actorLineColor: hex(r.muted),
    sequenceNumberColor: hex(r.onFill),
    activationBkgColor: dark ? hex({ s: 'dk2', off: 0.16 }) : hex({ s: 'lt2' }),
    activationBorderColor: hex(r.accent),
    altBackground: dark ? hex({ s: 'dk2', off: 0.05 }) : hex({ s: 'lt2' }),
    taskBkgColor: hex(r.accent),
    taskBorderColor: hex(r.accent),
    taskTextColor: hex(r.onFill),
    taskTextOutsideColor: hex(r.text),
  };
  // The export page initialises Mermaid with the chat's light theme, and its label colour outlives a directive's variables;
  // this CSS is what makes a dark deck's labels light there too.
  const ink = hex(r.text);
  const themeCSS = `.label text, .nodeLabel, .edgeLabel, .label span, text.actor, .messageText, .noteText, .loopText { fill: ${ink} !important; color: ${ink} !important; }`;
  const init = { theme: 'base', themeVariables: vars, themeCSS, flowchart: { htmlLabels: false, curve: 'basis', nodeSpacing: 28, rankSpacing: 38, padding: 12 } };
  return `%%{init: ${JSON.stringify(init)}}%%\n${source}`;
}
