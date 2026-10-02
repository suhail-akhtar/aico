/**
 * AICO Sheets — the grid a `sheet` canvas opens in: select, type, paste from
 * Excel, fill down, insert and delete rows and columns, sort, filter, freeze,
 * number formats, fills, conditional fills, charts from a range, several
 * sheets — with every formula recomputed live as you type.
 *
 * ## Saving: operations, replayed over the agent's writes
 *
 * Every change is a `SheetOp` (`sheet-model.ts`) applied to the local
 * workbook and kept until saved. The save sends the workbook with the version
 * it was based on, like a document's autosave. When the agent wrote in
 * between (a 409, or a `canvas` frame while edits are pending) the pending
 * operations are replayed on the agent's version and saved on top — so the
 * person filling column B while the agent adds a total row is not a conflict.
 * Replay is by address: the grid sees the agent's resulting workbook, not its
 * operations, so if the agent inserted rows above a pending edit (within the
 * ~0.6 s before it saves), that edit lands at its original address. An undo
 * (which restores a snapshot) can overwrite a concurrent agent change; it is
 * the person's explicit act.
 *
 * ## Why one grid component and no grid library
 *
 * The three builds (web, desktop, the VS Code webview) share `shared/ui` with
 * no new dependency (AGENTS.md §6); a grid library is a large one, and the
 * features needed sit on a plain table: rows are virtualised (only the
 * visible ones render, so an imported 10,000-row CSV scrolls), the header row
 * and frozen rows are sticky, and charts reuse the chat's ECharts block.
 *
 * Not here: merged cells, borders, fonts, multi-range selection, find and
 * replace, cell comments. Filters are a view (not saved per column); the
 * .xlsx gets an autoFilter over the data.
 *
 * @module shared/ui/canvas/SheetEditor
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Chart } from '../Chart';
import { chartOption } from './visual';
import { onCanvasEvent, type CanvasDoc, type CanvasHost, type CanvasRef } from './host';
import { saveBlob } from './export';
import { CvIcon } from './icons';
import {
  a1, applyOp, chartData, colName, computeBook, condFill, currencySymbol, editText, formatValue, gridCells, isError,
  parseBook, parseDelimited, rangeA1, replay, serializeBook, usedExtent, DEFAULT_COL_PX, NUM_KINDS,
  type Cell, type CondOp, type NumKind, type Sheet, type SheetBook, type SheetChartType, type SheetOp, type Value,
} from './sheet-model';
import { shiftFormula } from './sheet-formula';
import './sheet.css';

const ROW_H = 26;
const HEAD_H = 26;
const ROW_NUM_W = 48;
const SAVE_MS = 600;
const FILLS = ['#fff2cc', '#e2efda', '#ddebf7', '#fde2e2', '#ede7f6', '#f2f2f2'];
const CURRENCIES = ['USD', 'GBP', 'EUR', 'INR', 'AED', 'JPY', 'AUD', 'CAD'];
const KIND_LABEL: Record<NumKind, string> = { general: 'General', number: 'Number', currency: 'Currency', percent: 'Percent', date: 'Date', text: 'Text' };

interface Pos { r: number; c: number }
interface Sel { anchor: Pos; focus: Pos }
interface Editing { r: number; c: number; text: string; bar: boolean }

function rangeOf(s: Sel): { r1: number; c1: number; r2: number; c2: number } {
  return {
    r1: Math.min(s.anchor.r, s.focus.r), r2: Math.max(s.anchor.r, s.focus.r),
    c1: Math.min(s.anchor.c, s.focus.c), c2: Math.max(s.anchor.c, s.focus.c),
  };
}

function message(err: unknown): string { return err instanceof Error ? err.message : String(err); }

function base64Of(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export interface SheetEditorProps {
  host: CanvasHost;
  id: string;
  initial?: CanvasRef;
  variant?: 'panel' | 'inline';
  onClose?: () => void;
  /** Open another canvas (an import) where this client opens canvases. */
  openOther?: (ref: CanvasRef) => void;
}

export function SheetEditor({ host, id, initial, variant = 'panel', onClose, openOther }: SheetEditorProps): React.ReactElement {
  const [doc, setDoc] = useState<CanvasDoc | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [book, setBookState] = useState<SheetBook | null>(null);
  const [sheetId, setSheetId] = useState('s1');
  const [sel, setSel] = useState<Sel>({ anchor: { r: 0, c: 0 }, focus: { r: 0, c: 0 } });
  const [editing, setEditing] = useState<Editing | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [filters, setFilters] = useState<Record<number, string>>({});
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(600);
  const [menu, setMenu] = useState<'fill' | 'cond' | 'export' | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [titleEdit, setTitleEdit] = useState<string | null>(null);

  const bookRef = useRef<SheetBook | null>(null);
  const baseRef = useRef(0);
  const pendingRef = useRef<SheetOp[]>([]);
  const savingRef = useRef(false);
  const undoRef = useRef<SheetBook[]>([]);
  const redoRef = useRef<SheetBook[]>([]);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const clipRef = useRef<{ text: string; cells: Array<Array<Cell | undefined>>; origin: Pos } | null>(null);
  const dragRef = useRef(false);
  const flashTimer = useRef<number | undefined>(undefined);
  const saveTimer = useRef<number | undefined>(undefined);

  const show = useCallback((s: string) => {
    setFlash(s);
    window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(f => (f === s ? null : f)), 3500);
  }, []);

  const setBook = useCallback((b: SheetBook) => { bookRef.current = b; setBookState(b); }, []);

  const adopt = useCallback((d: CanvasDoc) => {
    setDoc(d);
    baseRef.current = d.tabs?.[0]?.version ?? d.version;
    try {
      const b = parseBook(d.tabs?.[0]?.content ?? d.content);
      setBook(b);
      setSheetId(cur => (b.sheets.some(s => s.id === cur) ? cur : b.sheets[0]!.id));
    } catch (err) { setLoadError(message(err)); }
  }, [setBook]);

  // ── Load ──
  useEffect(() => {
    let live = true;
    host.get(id).then(d => { if (live) adopt(d); }, err => { if (live) setLoadError(message(err)); });
    return () => { live = false; };
  }, [host, id, adopt]);

  // ── Save: the workbook with its base version; a newer version gets the pending ops replayed on it ──
  const save = useCallback(async (): Promise<void> => {
    if (savingRef.current || !pendingRef.current.length || !bookRef.current) return;
    savingRef.current = true;
    setSaving(true);
    const sent = pendingRef.current.length;
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const r = await host.save(id, serializeBook(bookRef.current!), baseRef.current, 'Edited the sheet');
        if (r.ok) {
          setDoc(r.canvas);
          baseRef.current = r.canvas.tabs?.[0]?.version ?? r.canvas.version;
          pendingRef.current = pendingRef.current.slice(sent);
          setDirty(pendingRef.current.length > 0);
          break;
        }
        // The agent (or another window) wrote first: replay what is pending on its version.
        const latest = parseBook(r.canvas.tabs?.[0]?.content ?? r.canvas.content);
        const re = replay(latest, pendingRef.current);
        setDoc(r.canvas);
        baseRef.current = r.canvas.tabs?.[0]?.version ?? r.canvas.version;
        setBook(re.book);
        show(re.skipped ? `AICO changed the sheet — ${re.skipped} of your edits no longer applied` : 'AICO changed the sheet — your edits are kept on top');
      }
    } catch (err) {
      show(`Not saved: ${message(err)}`);
    } finally {
      savingRef.current = false;
      setSaving(false);
      if (pendingRef.current.length) { window.clearTimeout(saveTimer.current); saveTimer.current = window.setTimeout(() => { void save(); }, SAVE_MS); }
    }
  }, [host, id, setBook, show]);

  // Leaving with edits pending: send them, best effort.
  useEffect(() => () => {
    window.clearTimeout(saveTimer.current);
    if (pendingRef.current.length && bookRef.current && !savingRef.current) {
      void host.save(id, serializeBook(bookRef.current), baseRef.current, 'Edited the sheet').catch(() => undefined);
    }
  }, [host, id]);

  // ── Live: the agent's writes arrive as canvas frames ──
  useEffect(() => onCanvasEvent((change) => {
    if (change.id !== id) return;
    const sid = host.sessionId();
    if (change.sessionId && sid && change.sessionId !== sid) return;
    if ((change.tabVersion ?? change.version) <= baseRef.current && change.action !== 'rename') return;
    void host.get(id).then((d) => {
      const v = d.tabs?.[0]?.version ?? d.version;
      if (v <= baseRef.current) { setDoc(d); return; }
      if (!pendingRef.current.length && !savingRef.current) {
        adopt(d);
        const last = d.versions[d.versions.length - 1];
        if (last?.author !== 'user') show(`AICO updated the sheet — version ${v}`);
        return;
      }
      if (savingRef.current) return; // the save's own 409 handles it
      const re = replay(parseBook(d.tabs?.[0]?.content ?? d.content), pendingRef.current);
      setDoc(d);
      baseRef.current = v;
      setBook(re.book);
      show('AICO changed the sheet — your edits are kept on top');
      void save();
    }, () => undefined);
  }), [host, id, adopt, save, setBook, show]);

  // ── Changing it ──
  const apply = useCallback((op: SheetOp | SheetOp[], opts: { quiet?: boolean } = {}): boolean => {
    const cur = bookRef.current;
    if (!cur) return false;
    const ops = Array.isArray(op) ? op : [op];
    let next = cur;
    try {
      for (const o of ops) next = applyOp(next, o);
    } catch (err) {
      if (!opts.quiet) show(message(err));
      return false;
    }
    undoRef.current = [...undoRef.current.slice(-49), cur];
    redoRef.current = [];
    pendingRef.current.push(...ops);
    setBook(next);
    setDirty(true);
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => { void save(); }, SAVE_MS);
    return true;
  }, [save, setBook, show]);

  const undo = useCallback((redo = false) => {
    const from = redo ? redoRef.current : undoRef.current;
    const to = redo ? undoRef.current : redoRef.current;
    const snap = from.pop();
    if (!snap || !bookRef.current) return;
    to.push(bookRef.current);
    pendingRef.current.push({ op: 'replace', book: snap });
    setBook(snap);
    setDirty(true);
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => { void save(); }, SAVE_MS);
  }, [save, setBook]);

  const sheet: Sheet | undefined = book?.sheets.find(s => s.id === sheetId) ?? book?.sheets[0];
  const computed = useMemo(() => (book ? computeBook(book) : null), [book]);
  const ext = useMemo(() => (sheet ? usedExtent(sheet) : { rows: 0, cols: 0 }), [sheet]);
  const nRows = Math.max(ext.rows + 50, 100, sel.focus.r + 20);
  const nCols = Math.max(ext.cols + 4, 12, sel.focus.c + 3);
  const freezeRows = sheet?.freeze?.rows ?? 0;
  const widths = useMemo(() => Array.from({ length: nCols }, (_, c) => sheet?.cols?.[colName(c)] ?? DEFAULT_COL_PX), [sheet, nCols]);
  const valueAt = useCallback((r: number, c: number): Value => (computed && sheet ? computed.at(sheet.id, r, c) : null), [computed, sheet]);

  // Rows on screen: frozen ones always; the rest filtered, then windowed.
  const filterOn = Boolean(sheet?.filter);
  const bodyRows = useMemo(() => {
    const active = Object.entries(filters).filter(([, t]) => t.trim());
    const out: number[] = [];
    for (let r = freezeRows; r < nRows; r++) {
      if (filterOn && active.length) {
        if (r >= ext.rows) break;
        const keep = active.every(([c, t]) => formatValue(valueAt(r, Number(c)), sheet?.cells[a1(r, Number(c))]?.s).toLowerCase().includes(t.trim().toLowerCase()));
        if (!keep) continue;
      }
      out.push(r);
    }
    return out;
  }, [filters, filterOn, freezeRows, nRows, ext.rows, valueAt, sheet]);
  const stickyH = HEAD_H + (filterOn ? ROW_H : 0) + freezeRows * ROW_H;
  const first = Math.max(0, Math.floor((scrollTop - stickyH) / ROW_H) - 10);
  const last = Math.min(bodyRows.length, first + Math.ceil(viewH / ROW_H) + 30);

  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [book !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Selection and editing ──
  const range = rangeOf(sel);
  const active = sel.focus;
  const activeCell = sheet?.cells[a1(active.r, active.c)];
  const sheetName = sheet?.name ?? 'Sheet1';

  const scrollIntoView = useCallback((p: Pos) => {
    const el = gridRef.current;
    if (!el) return;
    const idx = p.r < freezeRows ? -1 : bodyRows.indexOf(p.r);
    if (idx >= 0) {
      const top = stickyH + idx * ROW_H;
      if (top - stickyH < el.scrollTop) el.scrollTop = top - stickyH;
      else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight;
    }
    const left = ROW_NUM_W + widths.slice(0, p.c).reduce((s, w) => s + w, 0);
    if (left - ROW_NUM_W < el.scrollLeft) el.scrollLeft = left - ROW_NUM_W;
    else if (left + widths[p.c]! > el.scrollLeft + el.clientWidth) el.scrollLeft = left + widths[p.c]! - el.clientWidth;
  }, [bodyRows, freezeRows, stickyH, widths]);

  const move = useCallback((dr: number, dc: number, extend = false) => {
    setSel((s) => {
      let r = s.focus.r;
      if (dr) {
        if (r < freezeRows || !filterOn) r = Math.max(0, r + dr);
        else {
          const i = bodyRows.indexOf(r);
          r = dr < 0 && i <= 0 ? Math.max(0, freezeRows - 1) : bodyRows[Math.max(0, Math.min(bodyRows.length - 1, i + dr))] ?? r;
        }
      }
      const focus = { r, c: Math.max(0, s.focus.c + dc) };
      scrollIntoView(focus);
      return extend ? { anchor: s.anchor, focus } : { anchor: focus, focus };
    });
  }, [bodyRows, filterOn, freezeRows, scrollIntoView]);

  const commit = useCallback((e: Editing, then?: () => void) => {
    const before = editText(sheet?.cells[a1(e.r, e.c)]);
    setEditing(null);
    if (e.text !== before) apply({ op: 'set', sheet: sheetName, cells: { [a1(e.r, e.c)]: e.text } });
    gridRef.current?.focus();
    then?.();
  }, [apply, sheet, sheetName]);

  const startEdit = useCallback((text?: string) => {
    setEditing({ r: active.r, c: active.c, text: text ?? editText(sheet?.cells[a1(active.r, active.c)]), bar: false });
  }, [active, sheet]);

  const selRef = (): string => rangeA1(range);

  // ── Clipboard ──
  const copy = useCallback(async (cut = false) => {
    if (!sheet) return;
    const rows: string[] = [];
    const cells: Array<Array<Cell | undefined>> = [];
    for (let r = range.r1; r <= range.r2; r++) {
      const line: string[] = [];
      const row: Array<Cell | undefined> = [];
      for (let c = range.c1; c <= range.c2; c++) {
        const cell = sheet.cells[a1(r, c)];
        row.push(cell);
        line.push(formatValue(valueAt(r, c), cell?.s).replace(/[\t\n]/g, ' '));
      }
      rows.push(line.join('\t'));
      cells.push(row);
    }
    const text = rows.join('\n');
    clipRef.current = { text, cells, origin: { r: range.r1, c: range.c1 } };
    try { await navigator.clipboard.writeText(text); } catch { /* the internal copy still pastes here */ }
    if (cut) {
      const clear: Record<string, unknown> = {};
      for (let r = range.r1; r <= range.r2; r++) for (let c = range.c1; c <= range.c2; c++) clear[a1(r, c)] = null;
      apply({ op: 'set', sheet: sheetName, cells: clear });
    }
  }, [apply, range, sheet, sheetName, valueAt]);

  const paste = useCallback((text: string) => {
    if (!sheet) return;
    const clip = clipRef.current;
    const at = { r: range.r1, c: range.c1 };
    let cells: Record<string, unknown>;
    let h: number; let w: number;
    if (clip && clip.text === text.replace(/\r\n?/g, '\n').replace(/\n$/, '')) {
      // From this grid: formulas move with the paste, as in Excel.
      cells = {};
      clip.cells.forEach((row, i) => row.forEach((cell, j) => {
        const k = a1(at.r + i, at.c + j);
        cells[k] = !cell ? null : cell.f !== undefined ? `=${shiftFormula(cell.f, at.r - clip.origin.r, at.c - clip.origin.c)}` : editText(cell);
      }));
      h = clip.cells.length; w = clip.cells[0]?.length ?? 1;
    } else {
      const rows = parseDelimited(text);
      if (!rows.length) return;
      cells = gridCells(rows, at);
      h = rows.length; w = Math.max(...rows.map(r => r.length));
    }
    if (apply({ op: 'set', sheet: sheetName, cells })) {
      setSel({ anchor: at, focus: { r: at.r + h - 1, c: at.c + w - 1 } });
      if (h * w > 1) show(`Pasted ${h} × ${w}`);
    }
  }, [apply, range, sheet, sheetName, show]);

  useEffect(() => {
    const onPaste = (e: ClipboardEvent): void => {
      if (editing || document.activeElement !== gridRef.current) return;
      const text = e.clipboardData?.getData('text/plain');
      if (text) { e.preventDefault(); paste(text); }
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [editing, paste]);

  // ── Commands ──
  const setStyle = (style: Record<string, unknown>): void => { apply({ op: 'style', sheet: sheetName, range: selRef(), style }); };
  const dataRange = (): string => {
    // A multi-cell selection sorts itself; one cell sorts the data below the header by its column.
    if (range.r1 !== range.r2 || range.c1 !== range.c2) return selRef();
    const top = freezeRows || (sheet && typeof valueAt(0, active.c) === 'string' && ext.rows > 1 ? 1 : 0);
    return rangeA1({ r1: top, c1: 0, r2: Math.max(top, ext.rows - 1), c2: Math.max(0, ext.cols - 1) });
  };
  const sort = (desc: boolean): void => {
    if (apply({ op: 'sort', sheet: sheetName, range: dataRange(), col: active.c, ...(desc ? { desc } : {}) })) show(`Sorted by column ${colName(active.c)}${desc ? ' (Z→A)' : ' (A→Z)'}`);
  };
  const fillDown = (): void => {
    if (range.r1 === range.r2) { show('Select the cells to fill, with the source in the first row'); return; }
    apply({ op: 'fill', sheet: sheetName, range: selRef() });
  };
  const rowsCols = (op: 'insert' | 'delete', axis: 'row' | 'col'): void => {
    const at = axis === 'row' ? range.r1 : range.c1;
    const count = axis === 'row' ? range.r2 - range.r1 + 1 : range.c2 - range.c1 + 1;
    apply({ op, sheet: sheetName, axis, at, count });
  };
  const clear = (): void => {
    const cells: Record<string, unknown> = {};
    for (let r = range.r1; r <= range.r2; r++) for (let c = range.c1; c <= range.c2; c++) if (sheet?.cells[a1(r, c)]) cells[a1(r, c)] = null;
    if (Object.keys(cells).length) apply({ op: 'set', sheet: sheetName, cells });
  };

  const onKey = (e: React.KeyboardEvent): void => {
    if (editing || !sheet) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key;
    if (mod && k.toLowerCase() === 'z') { e.preventDefault(); undo(e.shiftKey); return; }
    if (mod && k.toLowerCase() === 'y') { e.preventDefault(); undo(true); return; }
    if (mod && k.toLowerCase() === 'c') { e.preventDefault(); void copy(); return; }
    if (mod && k.toLowerCase() === 'x') { e.preventDefault(); void copy(true); return; }
    if (mod && k.toLowerCase() === 'd') { e.preventDefault(); fillDown(); return; }
    if (mod && k.toLowerCase() === 'b') { e.preventDefault(); setStyle({ b: !activeCell?.s?.b }); return; }
    if (mod && k.toLowerCase() === 'a') { e.preventDefault(); setSel({ anchor: { r: 0, c: 0 }, focus: { r: Math.max(0, ext.rows - 1), c: Math.max(0, ext.cols - 1) } }); return; }
    if (mod && k === 'Home') { e.preventDefault(); setSel({ anchor: { r: 0, c: 0 }, focus: { r: 0, c: 0 } }); scrollIntoView({ r: 0, c: 0 }); return; }
    switch (k) {
      case 'ArrowUp': e.preventDefault(); move(mod ? -10_000 : -1, 0, e.shiftKey); return;
      case 'ArrowDown': e.preventDefault(); move(mod ? Math.max(1, ext.rows - 1 - active.r) : 1, 0, e.shiftKey); return;
      case 'ArrowLeft': e.preventDefault(); move(0, mod ? -active.c : -1, e.shiftKey); return;
      case 'ArrowRight': e.preventDefault(); move(0, mod ? Math.max(1, ext.cols - 1 - active.c) : 1, e.shiftKey); return;
      case 'Tab': e.preventDefault(); move(0, e.shiftKey ? -1 : 1); return;
      case 'Enter': e.preventDefault(); if (e.shiftKey) move(-1, 0); else startEdit(); return;
      case 'F2': e.preventDefault(); startEdit(); return;
      case 'Home': e.preventDefault(); move(0, -active.c, e.shiftKey); return;
      case 'PageDown': e.preventDefault(); move(20, 0, e.shiftKey); return;
      case 'PageUp': e.preventDefault(); move(-20, 0, e.shiftKey); return;
      case 'Delete': case 'Backspace': e.preventDefault(); clear(); return;
      case 'Escape': setMenu(null); return;
      default:
        if (k.length === 1 && !mod && !e.altKey) { e.preventDefault(); startEdit(k); }
    }
  };

  // ── Column resize ──
  const startResize = (c: number, e: React.MouseEvent): void => {
    e.preventDefault(); e.stopPropagation();
    const startX = e.clientX;
    const startW = widths[c]!;
    let w = startW;
    const el = document.querySelector<HTMLTableColElement>(`[data-sheet-col="${id}-${c}"]`);
    const mv = (ev: MouseEvent): void => { w = Math.max(30, Math.min(800, startW + ev.clientX - startX)); if (el) el.style.width = `${w}px`; };
    const up = (): void => {
      window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up);
      if (w !== startW) apply({ op: 'width', sheet: sheetName, col: colName(c), px: w });
    };
    window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
  };

  // ── Import / export / rename ──
  const exportAs = async (format: 'xlsx' | 'csv'): Promise<void> => {
    setMenu(null);
    if (!host.exportFile) { show('Export needs a newer engine'); return; }
    try {
      if (pendingRef.current.length) await save();
      const { blob, name } = await host.exportFile(id, format, undefined, undefined);
      const where = await saveBlob(name, blob, format);
      if (where) show(where === 'downloaded' ? `Downloaded ${name}` : `Saved to ${where}`);
    } catch (err) { show(`Export failed: ${message(err)}`); }
  };
  const importFile = (): void => {
    if (!host.importSheet) { show('Import needs a newer engine'); return; }
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.xlsx,.csv,.tsv';
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      try {
        const made = await host.importSheet!({ name: f.name, data: base64Of(await f.arrayBuffer()) });
        show(`Imported ${f.name}`);
        openOther?.({ id: made.id, title: made.title, kind: 'sheet' });
      } catch (err) { show(`Import failed: ${message(err)}`); }
    };
    input.click();
  };
  const renameDoc = async (title: string): Promise<void> => {
    setTitleEdit(null);
    if (!host.rename || !doc || !title.trim() || title.trim() === doc.title) return;
    try { setDoc(await host.rename(id, title.trim())); } catch (err) { show(message(err)); }
  };

  // ── Rendering ──
  if (loadError) return <div className="aw ash" data-variant={variant}><div className="ash-empty">This sheet could not be opened: {loadError}</div></div>;
  if (!book || !sheet || !computed) return <div className="aw ash" data-variant={variant}><div className="ash-empty">Opening {initial?.title ?? 'the sheet'}…</div></div>;

  const totalW = ROW_NUM_W + widths.reduce((s, w) => s + w, 0);
  const inSel = (r: number, c: number): boolean => r >= range.r1 && r <= range.r2 && c >= range.c1 && c <= range.c2;
  const selStats = (() => {
    if (range.r1 === range.r2 && range.c1 === range.c2) return '';
    let sum = 0; let n = 0; let count = 0;
    for (let r = range.r1; r <= Math.min(range.r2, ext.rows); r++) {
      for (let c = range.c1; c <= Math.min(range.c2, ext.cols); c++) {
        const v = valueAt(r, c);
        if (v !== null && v !== '') count++;
        if (typeof v === 'number') { sum += v; n++; }
      }
    }
    return n ? `Sum ${formatValue(Number(sum.toPrecision(12)))} · Average ${formatValue(Number((sum / n).toPrecision(10)))} · Count ${count}` : count ? `Count ${count}` : '';
  })();

  const cellView = (r: number, c: number, sticky?: number): React.ReactElement => {
    const k = a1(r, c);
    const cell = sheet.cells[k];
    const v = valueAt(r, c);
    const isActive = active.r === r && active.c === c;
    const edit = editing && editing.r === r && editing.c === c && !editing.bar;
    const fill = condFill(sheet, r, c, v) ?? cell?.s?.fill;
    const numeric = typeof v === 'number' || typeof v === 'boolean';
    const align = cell?.s?.align ?? (isError(v) || typeof v === 'boolean' ? 'center' : numeric ? 'right' : 'left');
    const cls = `ash-cell${inSel(r, c) ? ' is-sel' : ''}${isActive ? ' is-active' : ''}${isError(v) ? ' is-error' : ''}${cell?.s?.b ? ' is-bold' : ''}${sticky !== undefined ? ' is-frozen' : ''}`;
    return (
      <td key={c} className={cls} data-cell={k} title={isError(v) ? v.detail ?? v.error : undefined}
        style={{ ...(fill ? { background: fill } : {}), textAlign: align, ...(sticky !== undefined ? { top: sticky } : {}) }}
        onMouseDown={(e) => {
          if (e.button !== 0) return;
          if (editing && !(editing.r === r && editing.c === c)) {
            if (editing.text.startsWith('=') && !editing.bar) {
              // Building a formula: a click inserts the cell's reference.
              e.preventDefault();
              setEditing({ ...editing, text: editing.text + k });
              return;
            }
            commit(editing);
          }
          dragRef.current = true;
          setSel(s => (e.shiftKey ? { anchor: s.anchor, focus: { r, c } } : { anchor: { r, c }, focus: { r, c } }));
          gridRef.current?.focus();
        }}
        onMouseEnter={() => { if (dragRef.current) setSel(s => ({ anchor: s.anchor, focus: { r, c } })); }}
        onDoubleClick={() => { setSel({ anchor: { r, c }, focus: { r, c } }); setEditing({ r, c, text: editText(cell), bar: false }); }}>
        {edit ? (
          <input className="ash-input" autoFocus value={editing!.text} spellCheck={false}
            onChange={e => setEditing({ ...editing!, text: e.target.value })}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') { e.preventDefault(); commit(editing!, () => move(e.shiftKey ? -1 : 1, 0)); }
              else if (e.key === 'Tab') { e.preventDefault(); commit(editing!, () => move(0, e.shiftKey ? -1 : 1)); }
              else if (e.key === 'Escape') { setEditing(null); gridRef.current?.focus(); }
            }}
            onBlur={() => { if (editing && !editing.bar) commit(editing); }} />
        ) : formatValue(v, cell?.s)}
      </td>
    );
  };

  const rowView = (r: number, sticky?: number): React.ReactElement => (
    <tr key={r} style={{ height: ROW_H }}>
      <th className={`ash-rownum${r >= range.r1 && r <= range.r2 ? ' is-sel' : ''}${sticky !== undefined ? ' is-frozen' : ''}`}
        style={sticky !== undefined ? { top: sticky } : undefined}
        onMouseDown={() => { setSel({ anchor: { r, c: 0 }, focus: { r, c: nCols - 1 } }); gridRef.current?.focus(); }}>{r + 1}</th>
      {widths.map((_, c) => cellView(r, c, sticky))}
    </tr>
  );

  const windowed = bodyRows.slice(first, last);
  const kind: NumKind = activeCell?.s?.num ?? 'general';

  return (
    <div className="aw ash" data-variant={variant} onMouseUp={() => { dragRef.current = false; }}>
      <div className="ash-head">
        <CvIcon name="table" size={16} className="ash-kind" />
        {titleEdit !== null ? (
          <input className="ash-title-input" autoFocus value={titleEdit} aria-label="Sheet title"
            onChange={e => setTitleEdit(e.target.value)} onBlur={() => void renameDoc(titleEdit)}
            onKeyDown={(e) => { if (e.key === 'Enter') void renameDoc(titleEdit); if (e.key === 'Escape') setTitleEdit(null); }} />
        ) : (
          <button className="ash-title" title={host.rename ? 'Rename' : undefined} onClick={() => host.rename && setTitleEdit(doc?.title ?? '')}>{doc?.title ?? initial?.title ?? 'Sheet'}</button>
        )}
        <span className="ash-status">{flash ?? (saving ? 'Saving…' : dirty ? 'Edited' : `Version ${doc?.tabs?.[0]?.version ?? doc?.version ?? ''}`)}</span>
        <span className="ash-spacer" />
        <button className="aw-btn ash-btn" onClick={importFile} title="Import a .xlsx or .csv as a new sheet">Import</button>
        <div className="ash-menu-wrap">
          <button className="aw-btn ash-btn" onClick={() => setMenu(menu === 'export' ? null : 'export')} aria-haspopup="menu"><CvIcon name="download" size={13} /> Export</button>
          {menu === 'export' && (
            <div className="ash-menu" role="menu">
              <button role="menuitem" onClick={() => void exportAs('xlsx')}>Excel workbook (.xlsx)</button>
              <button role="menuitem" onClick={() => void exportAs('csv')}>CSV of this sheet{book.sheets.length > 1 ? ' (first sheet)' : ''}</button>
            </div>
          )}
        </div>
        {onClose && <button className="aw-icon-btn" onClick={onClose} title="Close" aria-label="Close the sheet"><CvIcon name="close" size={16} /></button>}
      </div>

      <div className="ash-toolbar" role="toolbar" aria-label="Sheet tools">
        <select className="ash-select" value={kind} aria-label="Number format"
          onChange={e => setStyle({ num: e.target.value, ...(e.target.value === 'currency' && !activeCell?.s?.cur ? { cur: 'USD' } : {}) })}>
          {NUM_KINDS.map(k => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
        </select>
        {kind === 'currency' && (
          <select className="ash-select" value={activeCell?.s?.cur ?? 'USD'} aria-label="Currency" onChange={e => setStyle({ cur: e.target.value })}>
            {CURRENCIES.map(c => <option key={c} value={c}>{currencySymbol(c).trim()} {c}</option>)}
          </select>
        )}
        <button className="aw-icon-btn" title="Fewer decimals" aria-label="Fewer decimals" onClick={() => setStyle({ dp: Math.max(0, (activeCell?.s?.dp ?? (kind === 'percent' ? 0 : 2)) - 1) })}>.0←</button>
        <button className="aw-icon-btn" title="More decimals" aria-label="More decimals" onClick={() => setStyle({ dp: Math.min(10, (activeCell?.s?.dp ?? (kind === 'percent' ? 0 : 2)) + 1) })}>.00→</button>
        <span className="ash-sep" />
        <button className={`aw-icon-btn${activeCell?.s?.b ? ' is-on' : ''}`} title="Bold (Ctrl+B)" aria-label="Bold" onClick={() => setStyle({ b: !activeCell?.s?.b })}><CvIcon name="bold" size={14} /></button>
        <div className="ash-menu-wrap">
          <button className="aw-icon-btn" title="Fill colour" aria-label="Fill colour" onClick={() => setMenu(menu === 'fill' ? null : 'fill')}>
            <span className="ash-swatch" style={{ background: activeCell?.s?.fill ?? 'transparent' }} />
          </button>
          {menu === 'fill' && (
            <div className="ash-menu ash-fills" role="menu">
              {FILLS.map(f => <button key={f} role="menuitem" aria-label={`Fill ${f}`} style={{ background: f }} onClick={() => { setStyle({ fill: f }); setMenu(null); }} />)}
              <button role="menuitem" onClick={() => { setStyle({ fill: null }); setMenu(null); }}>None</button>
            </div>
          )}
        </div>
        {(['left', 'center', 'right'] as const).map(al => (
          <button key={al} className={`aw-icon-btn${activeCell?.s?.align === al ? ' is-on' : ''}`} title={`Align ${al}`} aria-label={`Align ${al}`}
            onClick={() => setStyle({ align: activeCell?.s?.align === al ? null : al })}>{al === 'left' ? '⇤' : al === 'center' ? '↔' : '⇥'}</button>
        ))}
        <span className="ash-sep" />
        <button className="aw-icon-btn" title="Sort A→Z by this column" aria-label="Sort ascending" onClick={() => sort(false)}>A↓</button>
        <button className="aw-icon-btn" title="Sort Z→A by this column" aria-label="Sort descending" onClick={() => sort(true)}>Z↓</button>
        <button className={`aw-icon-btn${filterOn ? ' is-on' : ''}`} title="Filter rows" aria-label="Filter" onClick={() => { apply({ op: 'filter', sheet: sheetName, on: !filterOn }); setFilters({}); }}>⏷</button>
        <button className={`aw-icon-btn${freezeRows ? ' is-on' : ''}`} title={freezeRows ? 'Unfreeze the header' : 'Freeze rows above the selection (or the first row)'} aria-label="Freeze header"
          onClick={() => apply({ op: 'freeze', sheet: sheetName, rows: freezeRows ? 0 : Math.max(1, Math.min(range.r1, 10)) })}>❄</button>
        <span className="ash-sep" />
        <button className="aw-btn ash-btn" title="Insert rows above" onClick={() => rowsCols('insert', 'row')}>+ Row</button>
        <button className="aw-btn ash-btn" title="Insert columns to the left" onClick={() => rowsCols('insert', 'col')}>+ Col</button>
        <button className="aw-btn ash-btn" title="Delete the selected rows" onClick={() => rowsCols('delete', 'row')}>− Row</button>
        <button className="aw-btn ash-btn" title="Delete the selected columns" onClick={() => rowsCols('delete', 'col')}>− Col</button>
        <button className="aw-btn ash-btn" title="Fill down (Ctrl+D)" onClick={fillDown}>Fill ↓</button>
        <span className="ash-sep" />
        <div className="ash-menu-wrap">
          <button className={`aw-btn ash-btn${sheet.cond?.length ? ' is-on' : ''}`} onClick={() => setMenu(menu === 'cond' ? null : 'cond')} title="Conditional fill">Rules{sheet.cond?.length ? ` · ${sheet.cond.length}` : ''}</button>
          {menu === 'cond' && <CondMenu sheet={sheet} range={selRef()} onChange={rules => apply({ op: 'cond', sheet: sheetName, rules })} onClose={() => setMenu(null)} />}
        </div>
        <button className="aw-btn ash-btn" title="Chart the selection (first column = categories)"
          onClick={() => {
            if (range.r1 === range.r2 && range.c1 === range.c2) { show('Select a range to chart: categories in the first column, numbers beside'); return; }
            apply({ op: 'chart', sheet: sheetName, chart: { id: `c${Date.now().toString(36)}`, range: selRef(), type: 'bar' } });
          }}><CvIcon name="chart" size={13} /> Chart</button>
      </div>

      <div className="ash-bar">
        <span className="ash-namebox" aria-label="Selected cell">{selRef()}</span>
        <span className="ash-fx">fx</span>
        <input className="ash-formula" aria-label="Cell contents" spellCheck={false}
          value={editing?.bar ? editing.text : editing ? editing.text : editText(activeCell)}
          onFocus={() => setEditing({ r: active.r, c: active.c, text: editText(activeCell), bar: true })}
          onChange={e => setEditing({ r: active.r, c: active.c, text: e.target.value, bar: true })}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && editing) { e.preventDefault(); commit(editing, () => move(1, 0)); }
            if (e.key === 'Escape') { setEditing(null); gridRef.current?.focus(); }
          }}
          onBlur={() => { if (editing?.bar) commit(editing); }} />
        {isError(valueAt(active.r, active.c)) && <span className="ash-errnote" title={(valueAt(active.r, active.c) as { detail?: string }).detail}>{(valueAt(active.r, active.c) as { detail?: string }).detail}</span>}
      </div>

      <div className="ash-grid" ref={gridRef} tabIndex={0} onKeyDown={onKey} onScroll={e => setScrollTop((e.target as HTMLDivElement).scrollTop)}
        aria-label={`Sheet ${sheetName}`} role="grid" aria-rowcount={nRows} aria-colcount={nCols}>
        <table className="ash-table" style={{ width: totalW }}>
          <colgroup>
            <col style={{ width: ROW_NUM_W }} />
            {widths.map((w, c) => <col key={c} data-sheet-col={`${id}-${c}`} style={{ width: w }} />)}
          </colgroup>
          <thead>
            <tr style={{ height: HEAD_H }}>
              <th className="ash-corner" onMouseDown={() => setSel({ anchor: { r: 0, c: 0 }, focus: { r: Math.max(0, ext.rows - 1), c: Math.max(0, ext.cols - 1) } })} />
              {widths.map((_, c) => (
                <th key={c} className={`ash-colhead${c >= range.c1 && c <= range.c2 ? ' is-sel' : ''}`}
                  onMouseDown={() => { setSel({ anchor: { r: 0, c }, focus: { r: Math.max(0, ext.rows - 1), c } }); gridRef.current?.focus(); }}>
                  {colName(c)}
                  <span className="ash-resize" onMouseDown={e => startResize(c, e)} onDoubleClick={() => apply({ op: 'width', sheet: sheetName, col: colName(c), px: null })} />
                </th>
              ))}
            </tr>
            {filterOn && (
              <tr className="ash-filter-row" style={{ height: ROW_H }}>
                <th className="ash-rownum is-frozen" style={{ top: HEAD_H }}>⏷</th>
                {widths.map((_, c) => (
                  <th key={c} className="ash-filter is-frozen" style={{ top: HEAD_H }}>
                    <input aria-label={`Filter column ${colName(c)}`} placeholder="Filter" value={filters[c] ?? ''}
                      onChange={e => setFilters(f => ({ ...f, [c]: e.target.value }))} />
                  </th>
                ))}
              </tr>
            )}
          </thead>
          <tbody>
            {Array.from({ length: freezeRows }, (_, r) => rowView(r, HEAD_H + (filterOn ? ROW_H : 0) + r * ROW_H))}
            {first > 0 && <tr style={{ height: first * ROW_H }} aria-hidden="true"><td colSpan={nCols + 1} /></tr>}
            {windowed.map(r => rowView(r))}
            {last < bodyRows.length && <tr style={{ height: (bodyRows.length - last) * ROW_H }} aria-hidden="true"><td colSpan={nCols + 1} /></tr>}
          </tbody>
        </table>
        {filterOn && Object.values(filters).some(t => t.trim()) && bodyRows.length === 0 && <div className="ash-empty">No rows match the filter.</div>}
      </div>

      {sheet.charts?.length ? (
        <div className="ash-charts">
          {sheet.charts.map((ch) => {
            const data = chartData(sheet, ch.range, computed);
            const option = chartOption({ type: ch.type, title: ch.title ?? '', categories: data.categories, series: ch.type === 'pie' ? data.series.slice(0, 1) : data.series });
            return (
              <figure key={ch.id} className="ash-chart">
                <figcaption>
                  <input value={ch.title ?? ''} placeholder={`Chart of ${ch.range}`} aria-label="Chart title"
                    onChange={e => apply({ op: 'chart', sheet: sheetName, chart: { ...ch, title: e.target.value } }, { quiet: true })} />
                  <select value={ch.type} aria-label="Chart type" onChange={e => apply({ op: 'chart', sheet: sheetName, chart: { ...ch, type: e.target.value as SheetChartType } })}>
                    {(['bar', 'line', 'area', 'pie'] as const).map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                  <span className="ash-chart-range">{ch.range}</span>
                  <button className="aw-icon-btn" aria-label="Remove chart" title="Remove chart" onClick={() => apply({ op: 'chart', sheet: sheetName, chart: null, id: ch.id })}><CvIcon name="trash" size={13} /></button>
                </figcaption>
                <Chart source={option} />
              </figure>
            );
          })}
        </div>
      ) : null}

      <div className="ash-foot">
        <div className="ash-tabs" role="tablist">
          {book.sheets.map(s => (renaming === s.id ? (
            <input key={s.id} className="ash-tab-input" autoFocus defaultValue={s.name} aria-label="Sheet name"
              onBlur={(e) => { setRenaming(null); if (e.target.value.trim() && e.target.value !== s.name) apply({ op: 'rename_sheet', sheet: s.name, name: e.target.value }); }}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setRenaming(null); }} />
          ) : (
            <button key={s.id} role="tab" aria-selected={s.id === sheet.id} className={`ash-tab${s.id === sheet.id ? ' is-on' : ''}`}
              onClick={() => { setSheetId(s.id); setSel({ anchor: { r: 0, c: 0 }, focus: { r: 0, c: 0 } }); setFilters({}); }}
              onDoubleClick={() => setRenaming(s.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                if (book.sheets.length > 1 && window.confirm(`Delete the sheet "${s.name}"? Formulas that use it will show #REF!.`)) apply({ op: 'delete_sheet', sheet: s.name });
              }}
              title="Double-click to rename · right-click to delete">{s.name}</button>
          )))}
          <button className="ash-tab ash-tab-add" aria-label="Add a sheet" title="Add a sheet"
            onClick={() => { let n = book.sheets.length + 1; while (book.sheets.some(s => s.name.toLowerCase() === `sheet${n}`)) n++; apply({ op: 'add_sheet', name: `Sheet${n}` }); }}>+</button>
        </div>
        <span className="ash-stats">{selStats}</span>
      </div>
    </div>
  );
}

const COND_LABEL: Record<CondOp, string> = {
  gt: 'greater than', gte: 'at least', lt: 'less than', lte: 'at most', eq: 'equal to', ne: 'not equal to', between: 'between', contains: 'contains text', error: 'is an error',
};

function CondMenu({ sheet, range, onChange, onClose }: { sheet: Sheet; range: string; onChange: (rules: NonNullable<Sheet['cond']>) => void; onClose: () => void }): React.ReactElement {
  const [op, setOp] = useState<CondOp>('gt');
  const [value, setValue] = useState('');
  const [value2, setValue2] = useState('');
  const [fill, setFill] = useState(FILLS[3]!);
  const rules = sheet.cond ?? [];
  const asValue = (t: string): string | number => (t.trim() !== '' && Number.isFinite(Number(t)) ? Number(t) : t);
  return (
    <div className="ash-menu ash-cond" role="dialog" aria-label="Conditional fill">
      {rules.length > 0 && (
        <ul>
          {rules.map((r, i) => (
            <li key={i}><span className="ash-swatch" style={{ background: r.fill }} /> {r.range} {COND_LABEL[r.op]} {r.op === 'error' ? '' : String(r.value ?? '')}{r.op === 'between' ? ` and ${String(r.value2 ?? '')}` : ''}
              <button className="aw-icon-btn" aria-label="Remove rule" onClick={() => onChange(rules.filter((_, j) => j !== i))}><CvIcon name="trash" size={12} /></button></li>
          ))}
        </ul>
      )}
      <div className="ash-cond-new">
        <span>Fill {range} when the value is</span>
        <select value={op} onChange={e => setOp(e.target.value as CondOp)} aria-label="Condition">
          {(Object.keys(COND_LABEL) as CondOp[]).map(o => <option key={o} value={o}>{COND_LABEL[o]}</option>)}
        </select>
        {op !== 'error' && <input value={value} onChange={e => setValue(e.target.value)} placeholder="value" aria-label="Value" />}
        {op === 'between' && <input value={value2} onChange={e => setValue2(e.target.value)} placeholder="and" aria-label="Second value" />}
        <span className="ash-fills">{FILLS.map(f => <button key={f} aria-label={`Fill ${f}`} className={f === fill ? 'is-on' : ''} style={{ background: f }} onClick={() => setFill(f)} />)}</span>
        <button className="aw-btn ash-btn" onClick={() => {
          onChange([...rules, { range, op, fill, ...(op !== 'error' ? { value: asValue(value) } : {}), ...(op === 'between' ? { value2: asValue(value2) } : {}) }]);
          onClose();
        }}>Add rule</button>
      </div>
    </div>
  );
}
