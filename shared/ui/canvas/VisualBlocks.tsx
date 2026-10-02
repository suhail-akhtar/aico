/**
 * AICO Docs' visual blocks, drawn and edited in place: images (resize,
 * align, caption, alt text), callouts, tables (a real grid, with paste from
 * a spreadsheet), charts (type + a data grid), infographics (KPI stats,
 * timeline, steps, comparison) and the table of contents.
 *
 * Every editor here works on one block's Markdown (`visual.ts` reads and
 * writes it) and reports the whole block back only when the person changed
 * it — the page then replaces that block's span, as for any other block.
 * Previews are the chat's own renderer, so a chart looks here exactly as it
 * does in the transcript and the export.
 *
 * KPI tiles, steps and comparison columns use auto-fit grids whose minimum
 * tile width fits the longest word of a value (`statsMinWidth`, shared with
 * the exports), so a value wraps only at a space — never "Deskto / p".
 *
 * Deliberately plain: inputs and small grids rather than a spreadsheet
 * engine or a diagram canvas. The source of every block is one click away
 * ("Edit source") for anything these forms do not cover.
 *
 * @module shared/ui/canvas/VisualBlocks
 */

import React, { useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { MarkdownRenderer } from '../MarkdownRenderer';
import {
  CALLOUTS, INFOGRAPHIC_ALIASES, INFOGRAPHIC_FIELDS, calloutMarkdown, chartFromOption, chartOption, comparisonBody, fenced,
  infographicBody, infographicItems, parseCallout, parseComparison, parseFence, parseTable, parseTsv, tableToMarkdown, trendOf,
  type CalloutType, type ChartModel, type ChartType, type ColAlign, type ComparisonColumn, type ImageAlign, type ImageModel,
  type InfoItem, type InfographicKind, type TableModel, type TocEntry,
} from './visual';
import { CvIcon, type CanvasIconName } from './icons';
import { balancedColumns, ICON_NAMES, iconSvg, statsMinWidth, statValueSize, type IconName } from './doc-blocks';

/** `grid-template-columns` that wraps tiles to new rows instead of squeezing them. */
function fitColumns(minPx: number): React.CSSProperties {
  return { gridTemplateColumns: `repeat(auto-fit, minmax(min(${minPx}px, 100%), 1fr))`, gridAutoRows: '1fr' };
}

/** Close an editor when focus leaves it (for somewhere other than the toolbar). */
export function useFinishOnLeave(onDone: () => void): { ref: React.RefObject<HTMLDivElement | null>; onBlur: (e: React.FocusEvent) => void } {
  const ref = useRef<HTMLDivElement | null>(null);
  const done = useRef(false);
  const onBlur = (e: React.FocusEvent): void => {
    const next = e.relatedTarget as Node | null;
    if (next && (ref.current?.contains(next) || (next instanceof Element && next.closest('[data-adoc-keep-focus]')))) return;
    // A click on a non-focusable part of the editor blurs to nothing: keep it open.
    if (!next && ref.current?.matches(':hover')) return;
    if (!done.current) { done.current = true; onDone(); }
  };
  return { ref, onBlur };
}

export function useEscape(onDone: () => void): (e: React.KeyboardEvent) => void {
  return (e) => {
    if (e.key === 'Escape' || ((e.ctrlKey || e.metaKey) && e.key === 'Enter')) { e.preventDefault(); e.stopPropagation(); onDone(); }
  };
}

export function Seg<T extends string>({ value, options, onChange, label }: {
  value: T; options: ReadonlyArray<{ value: T; label: string; icon?: CanvasIconName }>; onChange: (v: T) => void; label: string;
}): React.ReactElement {
  return (
    <div className="acv-seg adoc-seg-text" role="group" aria-label={label}>
      {options.map(o => (
        <button key={o.value} type="button" className={o.value === value ? 'is-on' : ''} aria-pressed={o.value === value}
          title={o.label} onClick={() => onChange(o.value)}>
          {o.icon ? <CvIcon name={o.icon} size={13} /> : o.label}
        </button>
      ))}
    </div>
  );
}

// ── Images ───────────────────────────────────────────────────────────

export function ImageBlock({ img, readOnly, onChange }: {
  img: ImageModel; readOnly: boolean; onChange: (next: ImageModel) => void;
}): React.ReactElement {
  const [selected, setSelected] = useState(false);
  const [drag, setDrag] = useState<number | null>(null);
  const [caption, setCaption] = useState(img.caption ?? '');
  const [alt, setAlt] = useState(img.alt);
  const fig = useRef<HTMLElement | null>(null);
  useEffect(() => { setCaption(img.caption ?? ''); setAlt(img.alt); }, [img.caption, img.alt]);
  useEffect(() => {
    if (!selected) return;
    const away = (e: MouseEvent): void => { if (!fig.current?.contains(e.target as Node)) setSelected(false); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [selected]);

  const width = drag ?? img.width ?? 100;
  const align = img.align ?? 'center';

  const startResize = (e: React.PointerEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    const col = fig.current?.parentElement?.getBoundingClientRect();
    const box = fig.current?.querySelector('img')?.getBoundingClientRect();
    if (!col || !box) return;
    const fromRight = align === 'right';
    const move = (ev: PointerEvent): void => {
      const px = fromRight ? box.right - ev.clientX : ev.clientX - box.left;
      setDrag(Math.round(Math.max(10, Math.min(100, (px / col.width) * 100))));
    };
    const up = (ev: PointerEvent): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const px = fromRight ? box.right - ev.clientX : ev.clientX - box.left;
      const w = Math.round(Math.max(10, Math.min(100, (px / col.width) * 100)));
      setDrag(null);
      if (w !== (img.width ?? 100)) onChange({ ...img, width: w, ...(align === 'full' ? { align: 'center' as const } : {}) });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const commitText = (): void => {
    if (caption !== (img.caption ?? '') || alt !== img.alt) onChange({ ...img, alt, caption });
  };

  const style: React.CSSProperties = align === 'full' ? { width: '100%' } : { width: `${width}%` };
  return (
    <figure ref={fig} className={`adoc-figure is-${align}${selected ? ' is-selected' : ''}`} data-adoc-ui
      onClick={() => { if (!readOnly) setSelected(true); }}>
      <div className="adoc-figure-img" style={style}>
        <img src={img.src} alt={img.alt} draggable={false} />
        {selected && !readOnly && (
          <span className="adoc-resize" onPointerDown={startResize} title="Drag to resize" aria-label="Resize image" role="slider"
            aria-valuenow={width} aria-valuemin={10} aria-valuemax={100} />
        )}
        {drag !== null && <span className="adoc-resize-tip">{drag}%</span>}
      </div>
      {(img.caption || selected) && !readOnly && selected ? (
        <input className="adoc-caption-input" value={caption} placeholder="Add a caption" aria-label="Caption"
          onChange={e => setCaption(e.target.value)} onBlur={commitText}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitText(); (e.target as HTMLInputElement).blur(); } }} />
      ) : img.caption ? <figcaption>{img.caption}</figcaption> : null}
      {selected && !readOnly && (
        <div className="adoc-img-bar" onMouseDown={e => { if (!(e.target as HTMLElement).matches('input')) e.preventDefault(); }}>
          <Seg<ImageAlign> label="Alignment" value={align} onChange={a => onChange({ ...img, align: a })} options={[
            { value: 'left', label: 'Left' }, { value: 'center', label: 'Centre' }, { value: 'right', label: 'Right' }, { value: 'full', label: 'Full width' },
          ]} />
          <Seg<string> label="Size" value={String(img.width ?? 100)} onChange={w => onChange({ ...img, width: Number(w), ...(align === 'full' ? { align: 'center' as const } : {}) })} options={[
            { value: '33', label: 'S' }, { value: '50', label: 'M' }, { value: '75', label: 'L' }, { value: '100', label: 'XL' },
          ]} />
          <input className="adoc-alt-input" value={alt} placeholder="Alt text (describe the image)" aria-label="Alt text"
            onChange={e => setAlt(e.target.value)} onBlur={commitText}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitText(); } }} />
        </div>
      )}
    </figure>
  );
}

// ── Callouts ─────────────────────────────────────────────────────────

const CALLOUT_ICON: Record<CalloutType, CanvasIconName> = { info: 'callout', success: 'check', warn: 'warn' };

export function CalloutView({ text }: { text: string }): React.ReactElement | null {
  const c = parseCallout(text);
  if (!c) return null;
  const label = CALLOUTS.find(x => x.type === c.type)?.label ?? c.type;
  return (
    <div className={`adoc-callout is-${c.type}`}>
      <div className="adoc-callout-head">
        {/* eslint-disable-next-line react/no-danger -- a fixed SVG from the built-in icon set */}
        {c.icon ? <span className="adoc-callout-icon" dangerouslySetInnerHTML={{ __html: iconSvg(c.icon, 15) }} /> : <CvIcon name={CALLOUT_ICON[c.type]} size={14} />} {c.title || label}
      </div>
      {c.body && <MarkdownRenderer content={c.body} />}
    </div>
  );
}

export function CalloutEditor({ initial, onChange, onDone }: { initial: string; onChange: (md: string) => void; onDone: () => void }): React.ReactElement {
  const start = parseCallout(initial) ?? { type: 'info' as CalloutType, body: '' };
  const [type, setType] = useState<CalloutType>(start.type);
  const [title, setTitle] = useState(start.title ?? '');
  const [body, setBody] = useState(start.body);
  const [icon, setIcon] = useState<IconName | ''>(start.icon ?? '');
  const { ref, onBlur } = useFinishOnLeave(onDone);
  const area = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => { area.current?.focus({ preventScroll: true }); ref.current?.scrollIntoView({ block: 'nearest' }); }, [ref]);
  const model = (t: CalloutType, ti: string, b: string, ic: IconName | ''): Parameters<typeof calloutMarkdown>[0] =>
    ({ type: t, ...(ti.trim() ? { title: ti } : {}), body: b, ...(ic ? { icon: ic } : {}) });
  const emit = (t: CalloutType, ti: string, b: string, ic: IconName | ''): void => { onChange(calloutMarkdown(model(t, ti, b, ic))); };
  return (
    <div ref={ref} className="adoc-visual-edit" onBlur={onBlur} onKeyDown={useEscape(onDone)}>
      <div className="adoc-visual-bar">
        <Seg<CalloutType> label="Callout type" value={type} onChange={(t) => { setType(t); emit(t, title, body, icon); }}
          options={CALLOUTS.map(c => ({ value: c.type, label: c.label }))} />
        <div className="adoc-icon-pick" role="group" aria-label="Icon">
          <button type="button" className={icon === '' ? 'is-on' : ''} aria-pressed={icon === ''} title="The type's own icon"
            onClick={() => { setIcon(''); emit(type, title, body, ''); }}>Auto</button>
          {ICON_NAMES.map(n => (
            // eslint-disable-next-line react/no-danger -- a fixed SVG from the built-in icon set
            <button key={n} type="button" className={icon === n ? 'is-on' : ''} aria-pressed={icon === n} title={n} aria-label={`Icon ${n}`}
              onClick={() => { setIcon(n); emit(type, title, body, n); }} dangerouslySetInnerHTML={{ __html: iconSvg(n, 14) }} />
          ))}
        </div>
      </div>
      <input className="adoc-title-input" value={title} placeholder="Title (optional)" aria-label="Callout title"
        onChange={(e) => { setTitle(e.target.value); emit(type, e.target.value, body, icon); }} />
      <textarea ref={area} className="adoc-source-area is-prose" value={body} rows={3} aria-label="Callout text"
        onChange={(e) => { setBody(e.target.value); emit(type, title, e.target.value, icon); }} />
      <CalloutView text={calloutMarkdown(model(type, title, body, icon))} />
    </div>
  );
}

// ── Tables ───────────────────────────────────────────────────────────

export function TableEditor({ initial, onChange, onDone }: { initial: string; onChange: (md: string) => void; onDone: () => void }): React.ReactElement {
  const [t, setT] = useState<TableModel>(() => parseTable(initial) ?? { align: ['none', 'none'], header: ['Column 1', 'Column 2'], rows: [['', '']] });
  const [at, setAt] = useState<[number, number]>([0, 0]);
  const [headerRow, setHeaderRow] = useState(() => (parseTable(initial)?.header ?? ['x']).some(h => h.trim()));
  const { ref, onBlur } = useFinishOnLeave(onDone);
  const first = useRef(true);
  useLayoutEffect(() => {
    ref.current?.querySelector<HTMLInputElement>('input.adoc-cell')?.focus({ preventScroll: true });
    ref.current?.scrollIntoView({ block: 'nearest' });
  }, [ref]);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    onChange(tableToMarkdown(t));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t]);

  const cols = t.header.length;
  const grid = [t.header, ...t.rows];
  const set = (r: number, c: number, v: string): void => setT((p) => {
    const next = { ...p, header: [...p.header], rows: p.rows.map(x => [...x]) };
    if (r === 0) next.header[c] = v; else next.rows[r - 1]![c] = v;
    return next;
  });
  const addRow = (after: number): void => setT(p => ({ ...p, rows: [...p.rows.slice(0, after), Array(cols).fill(''), ...p.rows.slice(after)] }));
  const delRow = (r: number): void => setT(p => (p.rows.length > 1 && r > 0 ? { ...p, rows: p.rows.filter((_, i) => i !== r - 1) } : p));
  const addCol = (after: number): void => setT(p => ({
    align: [...p.align.slice(0, after), 'none', ...p.align.slice(after)],
    header: [...p.header.slice(0, after), `Column ${p.header.length + 1}`, ...p.header.slice(after)],
    rows: p.rows.map(r => [...r.slice(0, after), '', ...r.slice(after)]),
  }));
  const delCol = (c: number): void => setT(p => (p.header.length > 1 ? {
    align: p.align.filter((_, i) => i !== c), header: p.header.filter((_, i) => i !== c), rows: p.rows.map(r => r.filter((_, i) => i !== c)),
  } : p));
  const setAlign = (c: number, a: ColAlign): void => setT(p => ({ ...p, align: p.align.map((x, i) => (i === c ? a : x)) }));
  const toggleHeader = (on: boolean): void => {
    setHeaderRow(on);
    setT(p => (on
      ? (p.header.some(h => h.trim()) ? p : { ...p, header: p.rows[0] ?? p.header, rows: p.rows.length > 1 ? p.rows.slice(1) : [Array(p.header.length).fill('')] })
      : { ...p, header: Array(p.header.length).fill(''), rows: [p.header, ...p.rows] }));
  };

  const onPaste = (e: React.ClipboardEvent, r: number, c: number): void => {
    const grid2 = parseTsv(e.clipboardData.getData('text/plain'));
    if (!grid2) return;
    e.preventDefault();
    setT((p) => {
      const width = Math.max(p.header.length, c + Math.max(...grid2.map(g => g.length)));
      const pad = (row: string[]): string[] => Array.from({ length: width }, (_, i) => row[i] ?? '');
      const all = [pad(p.header), ...p.rows.map(pad)];
      grid2.forEach((row, i) => {
        const ri = r + i;
        while (all.length <= ri) all.push(Array(width).fill(''));
        row.forEach((v, j) => { all[ri]![c + j] = v; });
      });
      return { align: Array.from({ length: width }, (_, i) => p.align[i] ?? 'none'), header: all[0]!, rows: all.slice(1) };
    });
  };

  const key = (e: React.KeyboardEvent<HTMLInputElement>, r: number, c: number): void => {
    const move = (rr: number, cc: number): void => {
      ref.current?.querySelector<HTMLInputElement>(`input[data-cell="${rr}-${cc}"]`)?.focus();
    };
    if (e.key === 'Enter' && !e.shiftKey && !(e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (r === grid.length - 1) { addRow(t.rows.length); window.setTimeout(() => move(r + 1, c), 0); } else move(r + 1, c);
    } else if (e.key === 'ArrowDown') { e.preventDefault(); move(Math.min(grid.length - 1, r + 1), c); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(Math.max(0, r - 1), c); }
  };

  const [r0, c0] = at;
  return (
    <div ref={ref} className="adoc-visual-edit" onBlur={onBlur} onKeyDown={useEscape(onDone)}>
      <div className="adoc-visual-bar">
        <button type="button" className="aw-btn adoc-mini" onClick={() => addRow(Math.max(0, r0 - 1))}><CvIcon name="plus" size={11} /> Row above</button>
        <button type="button" className="aw-btn adoc-mini" onClick={() => addRow(r0)}><CvIcon name="plus" size={11} /> Row below</button>
        <button type="button" className="aw-btn adoc-mini" onClick={() => addCol(c0 + 1)}><CvIcon name="plus" size={11} /> Column</button>
        <button type="button" className="aw-btn adoc-mini" disabled={r0 === 0 || t.rows.length < 2} onClick={() => delRow(r0)}><CvIcon name="trash" size={11} /> Row</button>
        <button type="button" className="aw-btn adoc-mini" disabled={cols < 2} onClick={() => { delCol(c0); setAt([r0, Math.max(0, c0 - 1)]); }}><CvIcon name="trash" size={11} /> Column</button>
        <Seg<ColAlign> label="Column alignment" value={t.align[c0] ?? 'none'} onChange={a => setAlign(c0, a)} options={[
          { value: 'left', label: 'Left' }, { value: 'center', label: 'Centre' }, { value: 'right', label: 'Right' },
        ]} />
        <label className="adoc-ask-check"><input type="checkbox" checked={headerRow} onChange={e => toggleHeader(e.target.checked)} /> Header row</label>
      </div>
      <div className="adoc-grid-edit" role="grid" aria-label="Table">
        <table>
          <tbody>
            {grid.map((row, r) => (
              <tr key={r} className={r === 0 && headerRow ? 'is-head' : ''}>
                {row.map((v, c) => (
                  <td key={c} style={{ textAlign: (t.align[c] === 'none' ? 'left' : t.align[c]) as React.CSSProperties['textAlign'] }}>
                    <input className="adoc-cell" data-cell={`${r}-${c}`} value={v} aria-label={`Row ${r + 1}, column ${c + 1}`}
                      placeholder={r === 0 && headerRow ? `Heading ${c + 1}` : ''}
                      style={{ textAlign: (t.align[c] === 'none' ? 'left' : t.align[c]) as React.CSSProperties['textAlign'] }}
                      onFocus={() => setAt([r, c])} onChange={e => set(r, c, e.target.value)}
                      onPaste={e => onPaste(e, r, c)} onKeyDown={e => key(e, r, c)} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="adoc-source-hint">Tab moves between cells, Enter goes down (and adds a row at the end). Paste cells from Excel or Sheets. Esc to finish.</div>
    </div>
  );
}

// ── Charts ───────────────────────────────────────────────────────────

const CHART_TYPES: ReadonlyArray<{ value: ChartType; label: string }> = [
  { value: 'bar', label: 'Bar' }, { value: 'line', label: 'Line' }, { value: 'area', label: 'Area' }, { value: 'pie', label: 'Pie' },
];

/** Null when the chart is not one this editor can read back — the page edits it as source instead. */
export function chartModelOf(text: string): ChartModel | null {
  const f = parseFence(text);
  return f && f.lang === 'chart' ? chartFromOption(f.body) : null;
}

export function ChartEditor({ initial, onChange, onDone }: { initial: string; onChange: (md: string) => void; onDone: () => void }): React.ReactElement {
  const [m, setM] = useState<ChartModel>(() => chartModelOf(initial) ?? { type: 'bar', title: '', categories: ['A', 'B'], series: [{ name: 'Series 1', data: [1, 2] }] });
  const [draft, setDraft] = useState<Record<string, string>>({});
  const { ref, onBlur } = useFinishOnLeave(onDone);
  const first = useRef(true);
  const md = useMemo(() => fenced('chart', chartOption(m)), [m]);
  const shown = useDeferredValue(md);
  useLayoutEffect(() => { ref.current?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true }); ref.current?.scrollIntoView({ block: 'nearest' }); }, [ref]);
  useEffect(() => { if (first.current) { first.current = false; return; } onChange(md); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [md]);

  const series = m.type === 'pie' ? m.series.slice(0, 1) : m.series;
  const setCat = (i: number, v: string): void => setM(p => ({ ...p, categories: p.categories.map((c, j) => (j === i ? v : c)) }));
  const setName = (s: number, v: string): void => setM(p => ({ ...p, series: p.series.map((x, j) => (j === s ? { ...x, name: v } : x)) }));
  const setVal = (s: number, i: number, v: string): void => {
    setDraft(d => ({ ...d, [`${s}-${i}`]: v }));
    const n = Number(v.replace(/[, ]/g, ''));
    if (v.trim() === '' || Number.isFinite(n)) {
      setM(p => ({ ...p, series: p.series.map((x, j) => (j === s ? { ...x, data: p.categories.map((_, k) => (k === i ? (v.trim() === '' ? 0 : n) : x.data[k] ?? 0)) } : x)) }));
    }
  };
  const addRow = (): void => setM(p => ({ ...p, categories: [...p.categories, `Item ${p.categories.length + 1}`], series: p.series.map(s => ({ ...s, data: [...s.data, 0] })) }));
  const delRow = (i: number): void => setM(p => (p.categories.length > 1 ? { ...p, categories: p.categories.filter((_, j) => j !== i), series: p.series.map(s => ({ ...s, data: s.data.filter((_, j) => j !== i) })) } : p));
  const addSeries = (): void => setM(p => ({ ...p, series: [...p.series, { name: `Series ${p.series.length + 1}`, data: p.categories.map(() => 0) }] }));
  const delSeries = (s: number): void => setM(p => (p.series.length > 1 ? { ...p, series: p.series.filter((_, j) => j !== s) } : p));

  return (
    <div ref={ref} className="adoc-visual-edit adoc-side" onBlur={onBlur} onKeyDown={useEscape(onDone)}>
      <div className="adoc-side-form">
        <div className="adoc-visual-bar">
          <Seg<ChartType> label="Chart type" value={m.type} onChange={type => setM(p => ({ ...p, type }))} options={CHART_TYPES} />
        </div>
        <input className="adoc-title-input" value={m.title} placeholder="Chart title" aria-label="Chart title" onChange={e => setM(p => ({ ...p, title: e.target.value }))} />
        <div className="adoc-grid-edit">
          <table>
            <tbody>
              <tr className="is-head">
                <td><span className="adoc-grid-corner">{m.type === 'pie' ? 'Slice' : 'Category'}</span></td>
                {series.map((s, si) => (
                  <td key={si}>
                    <span className="adoc-cell-wrap">
                      <input className="adoc-cell" value={s.name} aria-label={`Series ${si + 1} name`} onChange={e => setName(si, e.target.value)} />
                      {series.length > 1 && <button type="button" className="adoc-cell-x" aria-label={`Remove ${s.name}`} onClick={() => delSeries(si)}>×</button>}
                    </span>
                  </td>
                ))}
              </tr>
              {m.categories.map((c, i) => (
                <tr key={i}>
                  <td>
                    <span className="adoc-cell-wrap">
                      <input className="adoc-cell" value={c} aria-label={`Category ${i + 1}`} onChange={e => setCat(i, e.target.value)} />
                      {m.categories.length > 1 && <button type="button" className="adoc-cell-x" aria-label={`Remove ${c}`} onClick={() => delRow(i)}>×</button>}
                    </span>
                  </td>
                  {series.map((s, si) => (
                    <td key={si}>
                      <input className="adoc-cell is-num" inputMode="decimal" aria-label={`${s.name}, ${c}`}
                        value={draft[`${si}-${i}`] ?? String(s.data[i] ?? 0)} onChange={e => setVal(si, i, e.target.value)}
                        onBlur={() => setDraft(d => { const n = { ...d }; delete n[`${si}-${i}`]; return n; })} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="adoc-visual-bar">
          <button type="button" className="aw-btn adoc-mini" onClick={addRow}><CvIcon name="plus" size={11} /> {m.type === 'pie' ? 'Slice' : 'Category'}</button>
          {m.type !== 'pie' && <button type="button" className="aw-btn adoc-mini" onClick={addSeries}><CvIcon name="plus" size={11} /> Series</button>}
        </div>
      </div>
      <div className="adoc-side-preview" aria-label="Preview"><MarkdownRenderer content={shown} /></div>
    </div>
  );
}

// ── Infographics ─────────────────────────────────────────────────────

export function infographicOf(text: string): { kind: InfographicKind; body: string } | null {
  const f = parseFence(text);
  if (!f) return null;
  const kind = (INFOGRAPHIC_ALIASES[f.lang] ?? f.lang) as InfographicKind;
  if (!['stats', 'timeline', 'steps', 'comparison'].includes(kind)) return null;
  return { kind, body: f.body };
}

function Inline({ text }: { text: string }): React.ReactElement {
  // Cells may carry inline Markdown (bold, links); the chat renderer draws it, minus the paragraph.
  return <span className="adoc-inline-md"><MarkdownRenderer content={text} /></span>;
}

/**
 * KPI tiles: auto-fit over a minimum that fits each value's longest word, and —
 * where the grid's own width is known — balanced rows (2 + 2 rather than 3 + 1).
 */
function StatsGrid({ items }: { items: InfoItem[] }): React.ReactElement {
  const min = statsMinWidth(items.map(r => r.value ?? ''));
  const box = useRef<HTMLDivElement | null>(null);
  const [cols, setCols] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const gap = 10;
    const measure = (): void => setCols(balancedColumns(items.length, (el.clientWidth + gap) / (min + gap)));
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, [items.length, min]);
  const style: React.CSSProperties = cols ? { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridAutoRows: '1fr' } : fitColumns(min);
  return (
    <div ref={box} className="adoc-stats" style={style}>
      {items.map((r, i) => (
        <div key={i} className="adoc-stat">
          <div className="adoc-stat-value" style={{ fontSize: `${statValueSize(r.value ?? '')}px` }}>{r.value}</div>
          <div className="adoc-stat-label">{r.label}</div>
          {r.delta && <div className={`adoc-stat-note is-${trendOf(r)}`}>{r.delta}</div>}
        </div>
      ))}
    </div>
  );
}

export function InfographicView({ kind, body }: { kind: InfographicKind; body: string }): React.ReactElement {
  if (kind === 'stats') return <StatsGrid items={infographicItems('stats', body)} />;
  if (kind === 'timeline') {
    const items = infographicItems('timeline', body);
    return (
      <ol className="adoc-timeline">
        {items.map((r, i) => (
          <li key={i}>
            <span className="adoc-tl-dot" />
            <div className="adoc-tl-when">{r.date}</div>
            <div className="adoc-tl-title"><Inline text={r.title ?? ''} /></div>
            {r.text && <div className="adoc-tl-detail"><Inline text={r.text} /></div>}
          </li>
        ))}
      </ol>
    );
  }
  if (kind === 'steps') {
    const items = infographicItems('steps', body);
    return (
      <ol className="adoc-steps" style={fitColumns(190)}>
        {items.map((r, i) => (
          <li key={i}>
            <span className="adoc-step-n">{i + 1}</span>
            <div><div className="adoc-step-title"><Inline text={r.title ?? ''} /></div>{r.text && <div className="adoc-step-detail"><Inline text={r.text} /></div>}</div>
          </li>
        ))}
      </ol>
    );
  }
  const cols = parseComparison(body);
  return (
    <div className="adoc-compare" style={fitColumns(cols.length > 3 ? 160 : 200)}>
      {cols.map((c, i) => (
        <div key={i} className={`adoc-compare-col${c.highlight ? ' is-highlight' : ''}`}>
          <div className="adoc-compare-title">{c.title}</div>
          <ul>{c.items.map((it, j) => <li key={j}><Inline text={it} /></li>)}</ul>
          {c.footer && <div className="adoc-compare-note">{c.footer}</div>}
        </div>
      ))}
    </div>
  );
}

export function InfographicEditor({ initial, onChange, onDone }: { initial: string; onChange: (md: string) => void; onDone: () => void }): React.ReactElement {
  const start = infographicOf(initial) ?? { kind: 'stats' as InfographicKind, body: '' };
  const kind = start.kind;
  const lang = parseFence(initial)?.lang ?? kind;
  const { ref, onBlur } = useFinishOnLeave(onDone);
  const esc = useEscape(onDone);
  useLayoutEffect(() => { ref.current?.querySelector<HTMLInputElement>('input, textarea')?.focus({ preventScroll: true }); ref.current?.scrollIntoView({ block: 'nearest' }); }, [ref]);

  if (kind === 'comparison') return <ComparisonEditor refEl={ref} onBlur={onBlur} onKey={esc} initial={parseComparison(start.body)} onChange={cols => onChange(fenced('comparison', comparisonBody(cols)))} />;
  return <ItemsEditor refEl={ref} onBlur={onBlur} onKey={esc} kind={kind} initial={infographicItems(kind, start.body)}
    onChange={items => onChange(fenced(lang, infographicBody(kind, items)))} />;
}

function ItemsEditor({ refEl, onBlur, onKey, kind, initial, onChange }: {
  refEl: React.RefObject<HTMLDivElement | null>; onBlur: (e: React.FocusEvent) => void; onKey: (e: React.KeyboardEvent) => void;
  kind: Exclude<InfographicKind, 'comparison'>; initial: InfoItem[]; onChange: (items: InfoItem[]) => void;
}): React.ReactElement {
  const fields = INFOGRAPHIC_FIELDS[kind];
  const [items, setItems] = useState<InfoItem[]>(initial.length ? initial : [{}]);
  const first = useRef(true);
  useEffect(() => { if (first.current) { first.current = false; return; } onChange(items); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [items]);
  const body = useDeferredValue(infographicBody(kind, items));
  const set = (i: number, key: string, v: string): void => setItems(p => p.map((x, k) => (k === i ? { ...x, [key]: v } : x)));
  return (
    <div ref={refEl} className="adoc-visual-edit" onBlur={onBlur} onKeyDown={onKey}>
      <div className="adoc-grid-edit">
        <table>
          <tbody>
            <tr className="is-head">
              {fields.map(f => <td key={f.key}><span className="adoc-grid-corner">{f.label}</span></td>)}
              {kind === 'stats' && <td><span className="adoc-grid-corner">Trend</span></td>}
              <td />
            </tr>
            {items.map((it, i) => (
              <tr key={i}>
                {fields.map(f => (
                  <td key={f.key}>
                    <input className="adoc-cell" value={it[f.key] ?? ''} aria-label={`${f.label} ${i + 1}`} onChange={e => set(i, f.key, e.target.value)} />
                  </td>
                ))}
                {kind === 'stats' && (
                  <td>
                    <select className="adoc-cell" value={it.trend ?? ''} aria-label={`Trend ${i + 1}`} onChange={e => set(i, 'trend', e.target.value)}>
                      <option value="">From the change</option><option value="up">Good (green)</option><option value="down">Bad (red)</option><option value="flat">Neutral</option>
                    </select>
                  </td>
                )}
                <td><button type="button" className="adoc-cell-x" aria-label={`Remove row ${i + 1}`} disabled={items.length < 2}
                  onClick={() => setItems(p => p.filter((_, k) => k !== i))}>×</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="adoc-visual-bar">
        <button type="button" className="aw-btn adoc-mini" onClick={() => setItems(p => [...p, {}])}><CvIcon name="plus" size={11} /> Add</button>
        <span className="adoc-source-hint">Esc to finish</span>
      </div>
      <div className="adoc-side-preview is-below"><InfographicView kind={kind} body={body} /></div>
    </div>
  );
}

function ComparisonEditor({ refEl, onBlur, onKey, initial, onChange }: {
  refEl: React.RefObject<HTMLDivElement | null>; onBlur: (e: React.FocusEvent) => void; onKey: (e: React.KeyboardEvent) => void;
  initial: ComparisonColumn[]; onChange: (cols: ComparisonColumn[]) => void;
}): React.ReactElement {
  const [cols, setCols] = useState<ComparisonColumn[]>(initial.length ? initial : [{ title: 'Option A', items: [] }, { title: 'Option B', items: [] }]);
  const first = useRef(true);
  useEffect(() => { if (first.current) { first.current = false; return; } onChange(cols); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [cols]);
  const patch = (i: number, p: Partial<ComparisonColumn>): void => setCols(c => c.map((x, j) => (j === i ? { ...x, ...p } : x)));
  return (
    <div ref={refEl} className="adoc-visual-edit" onBlur={onBlur} onKeyDown={onKey}>
      <div className="adoc-compare is-edit" style={{ gridTemplateColumns: `repeat(${Math.min(4, cols.length)}, minmax(0, 1fr))` }}>
        {cols.map((c, i) => (
          <div key={i} className={`adoc-compare-col${c.highlight ? ' is-highlight' : ''}`}>
            <input className="adoc-title-input" value={c.title} aria-label={`Column ${i + 1} title`} onChange={e => patch(i, { title: e.target.value })} />
            <textarea className="adoc-source-area is-prose" rows={4} value={c.items.join('\n')} placeholder="One point per line" aria-label={`Column ${i + 1} points`}
              onChange={e => patch(i, { items: e.target.value.split('\n') })} />
            <input className="adoc-cell" value={c.footer ?? ''} placeholder="Verdict (optional)" aria-label={`Column ${i + 1} verdict`} onChange={e => patch(i, { footer: e.target.value })} />
            <span className="adoc-visual-bar">
              <label className="adoc-ask-check"><input type="checkbox" checked={Boolean(c.highlight)} onChange={e => patch(i, { highlight: e.target.checked })} /> Highlight</label>
              {cols.length > 1 && <button type="button" className="aw-btn adoc-mini" onClick={() => setCols(p => p.filter((_, j) => j !== i))}><CvIcon name="trash" size={11} /> Remove</button>}
            </span>
          </div>
        ))}
      </div>
      <div className="adoc-visual-bar">
        {cols.length < 4 && <button type="button" className="aw-btn adoc-mini" onClick={() => setCols(p => [...p, { title: `Option ${String.fromCharCode(65 + p.length)}`, items: [] }])}><CvIcon name="plus" size={11} /> Column</button>}
        <span className="adoc-source-hint">Esc to finish</span>
      </div>
    </div>
  );
}

// ── Table of contents ────────────────────────────────────────────────

export function TocView({ entries, onGo }: { entries: TocEntry[]; onGo: (index: number) => void }): React.ReactElement {
  const top = Math.min(...entries.map(e => e.level), 6);
  return (
    <nav className="adoc-toc" aria-label="Table of contents" data-adoc-ui>
      <div className="adoc-toc-title">Contents</div>
      {entries.length === 0 ? <p className="adoc-empty-note">Headings will be listed here.</p> : (
        <ol>
          {entries.map(e => (
            <li key={e.index} className={e.pending ? 'is-pending' : undefined} style={{ paddingLeft: `${(e.level - top) * 16}px` }}>
              <button type="button" onClick={() => onGo(e.index)}>{e.text}</button>
            </li>
          ))}
        </ol>
      )}
    </nav>
  );
}

