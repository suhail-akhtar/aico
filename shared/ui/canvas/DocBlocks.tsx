/**
 * The document blocks of round 3 — signature, key-value box, line items,
 * risk matrix, action items, columns, cover band, meta line, references —
 * drawn and edited in place on the AICO Docs page.
 *
 * ## Drawn with the export's own HTML
 *
 * `DocBlockView` renders `docBlockHtml` from `doc-blocks.ts`, the string the
 * engine embeds in the HTML/PDF export, so the page and the PDF cannot
 * disagree on a total or a rating. Only columns are drawn here in React,
 * because their content is Markdown and the chat's renderer draws that.
 * The HTML is built from escaped text (`inlineMd` escapes before it adds
 * any markup), so nothing a model writes into a field becomes live HTML.
 *
 * ## One form editor, driven by a schema
 *
 * Nine blocks, one editor: each block is a few top-level fields plus at
 * most one list of rows, so `SCHEMAS` describes them and `DocBlockEditor`
 * draws inputs and a row grid, with the real block as the preview below.
 * Totals, scores and ratings are never fields — the preview computes them.
 *
 * @module shared/ui/canvas/DocBlocks
 */

import React, { useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { MarkdownRenderer } from '../MarkdownRenderer';
import {
  docBlockHtml, docBlockKind, docBlockMarkdown, parseDocBlock, type DocBlock, type DocBlockKind,
} from './doc-blocks';
import { parseFence } from './visual';
import { useEscape, useFinishOnLeave } from './VisualBlocks';
import { CvIcon } from './icons';

/** The block's kind and parse, or null when the text is not a document block. */
export function docBlockOf(text: string): { kind: DocBlockKind; parsed: ReturnType<typeof parseDocBlock> } | null {
  const f = parseFence(text);
  const kind = f ? docBlockKind(f.lang) : undefined;
  if (!f || !kind) return null;
  return { kind, parsed: parseDocBlock(kind, f.body, f.info) };
}

export function DocBlockView({ text }: { text: string }): React.ReactElement | null {
  const b = useMemo(() => docBlockOf(text), [text]);
  if (!b) return null;
  if (!b.parsed.ok) {
    return <div className="adoc-docblock-error"><CvIcon name="warn" size={13} /> {b.parsed.error} — open its source to fix it.</div>;
  }
  const v = b.parsed.value;
  if (v.kind === 'columns') {
    return (
      <div className={`db-cols db-cols-${v.layout}`}>
        {v.columns.map((c, i) => (
          <div key={i} className={`db-col${(v.layout === 'sidebar' && i === 0) || (v.layout === 'sidebar-right' && i === v.columns.length - 1) ? ' db-col-side' : ''}`}>
            <MarkdownRenderer content={c} />
          </div>
        ))}
      </div>
    );
  }
  // eslint-disable-next-line react/no-danger -- built from escaped text by doc-blocks (see the module header)
  return <div className="adoc-docblock" dangerouslySetInnerHTML={{ __html: docBlockHtml(v) }} />;
}

// ── The form editor ──────────────────────────────────────────────────

type FieldKind = 'text' | 'number' | 'select' | 'check' | 'lines' | 'area';
interface Field { key: string; label: string; kind?: FieldKind; options?: ReadonlyArray<readonly [string, string]>; placeholder?: string; width?: number }
interface Schema { label: string; top?: Field[]; list?: { key: string; label: string; fields: Field[]; max?: number; blank: () => Record<string, unknown> } }

const LEVELS = [['1', '1'], ['2', '2'], ['3', '3'], ['4', '4'], ['5', '5']] as const;

export const SCHEMAS: Record<DocBlockKind, Schema> = {
  signature: { label: 'Signature block', list: { key: 'parties', label: 'Signatories', max: 4, blank: () => ({ label: '', name: '', title: '' }), fields: [
    { key: 'label', label: 'Signing for', placeholder: 'For the Client' }, { key: 'name', label: 'Name' }, { key: 'title', label: 'Title' }, { key: 'date', label: 'Date', placeholder: 'blank line' },
  ] } },
  keyvalue: { label: 'Details box', top: [{ key: 'title', label: 'Title', placeholder: 'Details' }], list: { key: 'items', label: 'Rows', blank: () => ({ key: '', value: '' }), fields: [
    { key: 'key', label: 'Label' }, { key: 'value', label: 'Value', width: 2 },
  ] } },
  lineitems: { label: 'Line items', top: [
    { key: 'currency', label: 'Currency', placeholder: 'GBP' }, { key: 'taxRate', label: 'Tax %', kind: 'number' }, { key: 'taxLabel', label: 'Tax name', placeholder: 'VAT' },
    { key: 'discount', label: 'Discount', placeholder: '10% or 50' }, { key: 'notes', label: 'Notes', width: 3 },
  ], list: { key: 'items', label: 'Items', blank: () => ({ item: '', qty: 1, rate: 0 }), fields: [
    { key: 'item', label: 'Item', width: 2 }, { key: 'description', label: 'Description', width: 2 }, { key: 'qty', label: 'Qty', kind: 'number' },
    { key: 'unit', label: 'Unit' }, { key: 'rate', label: 'Rate', kind: 'number' },
  ] } },
  riskmatrix: { label: 'Risk matrix', list: { key: 'risks', label: 'Risks', blank: () => ({ id: '', title: '', likelihood: 3, impact: 3 }), fields: [
    { key: 'id', label: 'ID' }, { key: 'title', label: 'Risk', width: 2 }, { key: 'likelihood', label: 'Likelihood', kind: 'select', options: LEVELS },
    { key: 'impact', label: 'Impact', kind: 'select', options: LEVELS }, { key: 'owner', label: 'Owner' }, { key: 'mitigation', label: 'Mitigation', width: 2 },
  ] } },
  actions: { label: 'Action items', list: { key: 'items', label: 'Actions', blank: () => ({ action: '', status: 'open' }), fields: [
    { key: 'action', label: 'Action', width: 3 }, { key: 'owner', label: 'Owner' }, { key: 'due', label: 'Due' },
    { key: 'status', label: 'Status', kind: 'select', options: [['open', 'Open'], ['in progress', 'In progress'], ['done', 'Done'], ['blocked', 'Blocked']] },
  ] } },
  columns: { label: 'Columns', top: [{ key: 'layout', label: 'Layout', kind: 'select', options: [['sidebar', 'Sidebar left'], ['sidebar-right', 'Sidebar right'], ['even', 'Equal columns']] }] },
  cover: { label: 'Cover band', top: [
    { key: 'kicker', label: 'Kicker', placeholder: 'PROPOSAL' }, { key: 'title', label: 'Title', width: 2 }, { key: 'subtitle', label: 'Subtitle', width: 3 },
    { key: 'meta', label: 'Details (one per line)', kind: 'lines', width: 3 }, { key: 'pageBreak', label: 'New page after', kind: 'check' },
  ] },
  meta: { label: 'Meta line', top: [{ key: 'items', label: 'Items (one per line)', kind: 'lines', width: 3 }] },
  references: { label: 'References', list: { key: 'items', label: 'References', blank: () => ({ text: '' }), fields: [
    { key: 'text', label: 'Reference', width: 4 }, { key: 'url', label: 'Link', width: 2 },
  ] } },
};

type Model = Record<string, unknown>;

function FieldInput({ f, value, onChange, label }: { f: Field; value: unknown; onChange: (v: unknown) => void; label: string }): React.ReactElement {
  if (f.kind === 'select') {
    return (
      <select className="adoc-cell" aria-label={label} value={String(value ?? '')} onChange={e => onChange(/^\d+$/.test(e.target.value) ? Number(e.target.value) : e.target.value)}>
        {f.options!.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    );
  }
  if (f.kind === 'check') return <input type="checkbox" aria-label={label} checked={value === true} onChange={e => onChange(e.target.checked || undefined)} />;
  if (f.kind === 'lines' || f.kind === 'area') {
    return (
      <textarea className="adoc-source-area is-prose" rows={f.kind === 'lines' ? 3 : 5} aria-label={label} placeholder={f.placeholder}
        value={f.kind === 'lines' ? (Array.isArray(value) ? value.join('\n') : '') : String(value ?? '')}
        onChange={e => onChange(f.kind === 'lines' ? e.target.value.split('\n') : e.target.value)} />
    );
  }
  return (
    <input className={`adoc-cell${f.kind === 'number' ? ' is-num' : ''}`} aria-label={label} placeholder={f.placeholder}
      type={f.kind === 'number' ? 'number' : 'text'} step={f.kind === 'number' ? 'any' : undefined}
      value={value === undefined || value === null ? '' : String(value)}
      onChange={e => onChange(f.kind === 'number' ? (e.target.value === '' ? undefined : Number(e.target.value)) : e.target.value)} />
  );
}

/** Model → block, dropping what the form leaves empty (the block's serialiser drops the rest). */
function toBlock(kind: DocBlockKind, m: Model): DocBlock {
  const clean = (v: unknown): unknown => (Array.isArray(v) ? v.map(x => (typeof x === 'string' ? x.trim() : x)).filter(x => x !== '') : v);
  const out: Model = { kind };
  for (const [k, v] of Object.entries(m)) out[k] = clean(v);
  return out as unknown as DocBlock;
}

export function DocBlockEditor({ initial, onChange, onDone }: { initial: string; onChange: (md: string) => void; onDone: () => void }): React.ReactElement {
  const start = docBlockOf(initial);
  const kind = start?.kind ?? 'keyvalue';
  const schema = SCHEMAS[kind];
  const [m, setM] = useState<Model>(() => {
    if (start?.parsed.ok) { const { kind: _k, ...rest } = start.parsed.value as unknown as Model; return rest; }
    return { ...(schema.list ? { [schema.list.key]: [schema.list.blank()] } : {}) };
  });
  const { ref, onBlur } = useFinishOnLeave(onDone);
  const esc = useEscape(onDone);
  const first = useRef(true);
  const md = useMemo(() => docBlockMarkdown(toBlock(kind, m)), [kind, m]);
  const shown = useDeferredValue(md);
  useLayoutEffect(() => { ref.current?.querySelector<HTMLElement>('input, textarea, select')?.focus({ preventScroll: true }); ref.current?.scrollIntoView({ block: 'nearest' }); }, [ref]);
  useEffect(() => { if (first.current) { first.current = false; return; } onChange(md); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [md]);

  const set = (key: string, v: unknown): void => setM(p => ({ ...p, [key]: v }));
  const rows = schema.list ? ((m[schema.list.key] as Model[] | undefined) ?? []) : [];
  const setRow = (i: number, key: string, v: unknown): void => setM(p => ({
    ...p, [schema.list!.key]: (p[schema.list!.key] as Model[]).map((r, j) => (j === i ? { ...r, [key]: v } : r)),
  }));
  const addRow = (row: Model): void => setM(p => ({ ...p, [schema.list!.key]: [...((p[schema.list!.key] as Model[] | undefined) ?? []), row] }));
  const delRow = (i: number): void => setM(p => ({ ...p, [schema.list!.key]: (p[schema.list!.key] as Model[]).filter((_, j) => j !== i) }));
  const cols = (m.columns as string[] | undefined) ?? [];

  return (
    <div ref={ref} className="adoc-visual-edit adoc-docblock-edit" onBlur={onBlur} onKeyDown={esc}>
      <div className="adoc-visual-bar"><b className="adoc-docblock-name">{schema.label}</b><span className="adoc-source-hint">Esc to finish</span></div>
      {schema.top && (
        <div className="adoc-docblock-top">
          {schema.top.map(f => (
            <label key={f.key} className={`adoc-field${f.kind === 'check' ? ' is-check' : ''}`} style={{ flexGrow: f.width ?? 1 }}>
              <span>{f.label}</span>
              <FieldInput f={f} value={m[f.key]} label={f.label} onChange={v => set(f.key, v)} />
            </label>
          ))}
        </div>
      )}
      {kind === 'columns' && (
        <div className="adoc-docblock-cols">
          {cols.map((c, i) => (
            <label key={i} className="adoc-field">
              <span>Column {i + 1} (Markdown){cols.length > 2 && <button type="button" className="adoc-cell-x" aria-label={`Remove column ${i + 1}`} onClick={() => set('columns', cols.filter((_, j) => j !== i))}>×</button>}</span>
              <textarea className="adoc-source-area" rows={7} value={c} aria-label={`Column ${i + 1}`} onChange={e => set('columns', cols.map((x, j) => (j === i ? e.target.value : x)))} />
            </label>
          ))}
          {cols.length < 3 && <button type="button" className="aw-btn adoc-mini" onClick={() => set('columns', [...cols, ''])}><CvIcon name="plus" size={11} /> Column</button>}
        </div>
      )}
      {schema.list && (
        <div className="adoc-grid-edit">
          <table>
            <tbody>
              <tr className="is-head">
                {schema.list.fields.map(f => <td key={f.key}><span className="adoc-grid-corner">{f.label}</span></td>)}
                <td />
              </tr>
              {rows.map((r, i) => (r.section !== undefined ? (
                <tr key={i} className="is-section">
                  <td colSpan={schema.list!.fields.length}>
                    <input className="adoc-cell" aria-label={`Group heading ${i + 1}`} value={String(r.section ?? '')} placeholder="Group heading" onChange={e => setRow(i, 'section', e.target.value)} />
                  </td>
                  <td><button type="button" className="adoc-cell-x" aria-label={`Remove row ${i + 1}`} onClick={() => delRow(i)}>×</button></td>
                </tr>
              ) : (
                <tr key={i}>
                  {schema.list!.fields.map(f => (
                    <td key={f.key} style={{ minWidth: `${(f.width ?? 1) * 80}px` }}>
                      <FieldInput f={f} value={r[f.key]} label={`${f.label} ${i + 1}`} onChange={v => setRow(i, f.key, v)} />
                    </td>
                  ))}
                  <td><button type="button" className="adoc-cell-x" aria-label={`Remove row ${i + 1}`} disabled={rows.length < 2} onClick={() => delRow(i)}>×</button></td>
                </tr>
              )))}
            </tbody>
          </table>
        </div>
      )}
      {schema.list && (
        <div className="adoc-visual-bar">
          {(!schema.list.max || rows.length < schema.list.max) && (
            <button type="button" className="aw-btn adoc-mini" onClick={() => addRow(schema.list!.blank())}><CvIcon name="plus" size={11} /> Add</button>
          )}
          {kind === 'lineitems' && <button type="button" className="aw-btn adoc-mini" onClick={() => addRow({ section: 'New group' })}><CvIcon name="plus" size={11} /> Group heading</button>}
          {kind === 'lineitems' && <span className="adoc-source-hint">Amounts, subtotal, tax and total are calculated.</span>}
        </div>
      )}
      <div className="adoc-side-preview is-below"><DocBlockView text={shown} /></div>
    </div>
  );
}
