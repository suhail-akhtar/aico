/**
 * AICO Slides — the editor a `deck` canvas opens in: a slide sorter
 * (thumbnails you drag to reorder, duplicate, delete, add from a layout), the
 * slide itself, an inspector for the slide's fields, speaker notes, a theme
 * picker, export, and present mode with a presenter view.
 *
 * ## The person edits content, the layout engine places it
 *
 * There is no dragging of text boxes. A slide is a layout plus fields
 * (`deck-model.ts`), the same structure the agent writes, so the person and
 * the agent can edit one deck without fighting over coordinates — and every
 * edit re-runs the layout engine, which fits the text and outlines in red
 * anything that does not fit, with the reason listed under the slide.
 * Clicking a part of the slide focuses the field that edits it.
 *
 * ## Saving: operations replayed over the agent's writes
 *
 * As in the sheet editor, every change is a `DeckOp` kept until saved; the
 * save sends the deck with the version it was based on, and when the agent
 * wrote in between (a 409, or a live `canvas` frame while edits are pending)
 * the pending operations are replayed by slide id on the agent's version —
 * the person retitling slide 3 while the agent fills slide 8 is not a
 * conflict. An edit to a slide the agent deleted is dropped and said so.
 *
 * @module shared/ui/canvas/DeckEditor
 */

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { onCanvasEvent, type CanvasDoc, type CanvasHost, type CanvasRef } from './host';
import { saveBlob, pickImage } from './export';
import { CvIcon } from './icons';
import {
  LAYOUTS, applyDeckOp, blankSlide, duplicateSlide, isPending, layoutInfo, nextSlideId, normalizeSlide, parseDeck, replayDeck,
  serializeDeck, slideText, type Deck, type DeckChartType, type DeckLayout, type DeckOp, type Slide,
} from './deck-model';
import { layoutDeck, problemLines, type Problem, type SlideLayout } from './deck-layout';
import { DECK_THEMES, deckTheme } from './deck-themes';
import { DECK_TYPES, deckTypeById } from './deck-types';
import {
  bulletsToText, chartToText, dropIndex, kpisToText, tableToText, textToBullets, textToChart, textToKpis, textToTable,
  textToTimeline, timelineToText,
} from './deck-edit';
import { DeckPresent, DeckSlide } from './DeckSlide';
import './deck.css';

const SAVE_MS = 600;
const CHART_TYPES: DeckChartType[] = ['column', 'bar', 'stacked', 'line', 'area', 'pie', 'doughnut'];

function message(err: unknown): string { return err instanceof Error ? err.message : String(err); }

export interface DeckEditorProps {
  host: CanvasHost;
  id: string;
  initial?: CanvasRef;
  variant?: 'panel' | 'inline';
  onClose?: () => void;
  openOther?: (ref: CanvasRef) => void;
}

/** A text field that keeps what the person typed (spaces, a half-written line) while the slide stores the normalised value. */
function Field({ label, value, onChange, multiline, rows, placeholder, focusKey, focused, hint }: {
  label: string; value: string; onChange: (v: string) => void; multiline?: boolean; rows?: number; placeholder?: string;
  focusKey?: string; focused?: string | null; hint?: string;
}): React.ReactElement {
  const [local, setLocal] = useState(value);
  const editing = useRef(false);
  const ref = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  useEffect(() => { if (!editing.current) setLocal(value); }, [value]);
  useEffect(() => {
    // `focused` is "field:stamp", so clicking the same part of the slide twice focuses it twice.
    if (focusKey && focused && focused.split(':')[0] === focusKey && ref.current) { ref.current.focus(); ref.current.scrollIntoView({ block: 'nearest' }); }
  }, [focused, focusKey]);
  const props = {
    ref, value: local, placeholder, 'aria-label': label, spellCheck: true,
    onFocus: () => { editing.current = true; },
    onBlur: () => { editing.current = false; setLocal(value); },
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => { setLocal(e.target.value); onChange(e.target.value); },
  };
  return (
    <label className="adk-field">
      <span className="adk-field-label">{label}{hint ? <span className="adk-hint"> — {hint}</span> : null}</span>
      {multiline ? <textarea rows={rows ?? 4} {...props} /> : <input {...props} />}
    </label>
  );
}

/** A picked picture as a JPEG data URL, at most 1600 px — a canvas tab holds 400k characters, not a camera original. */
async function pictureDataUrl(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('not a picture this browser can read'));
      i.src = url;
    });
    const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
    for (const q of [0.85, 0.72, 0.6]) {
      const data = canvas.toDataURL('image/jpeg', q);
      if (data.length < 260_000) return data;
    }
    throw new Error('the picture is too detailed to embed — use a smaller one, or ask AICO to place a project file');
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function DeckEditor({ host, id, initial, variant = 'panel', onClose, openOther }: DeckEditorProps): React.ReactElement {
  const [doc, setDoc] = useState<CanvasDoc | null>(null);
  const [deck, setDeckState] = useState<Deck | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [menu, setMenu] = useState<'theme' | 'layout' | 'add' | 'export' | 'new' | null>(null);
  const [presenting, setPresenting] = useState<{ at: number; presenter: boolean } | null>(null);
  const [focusField, setFocusField] = useState<string | null>(null);
  const [titleEdit, setTitleEdit] = useState<string | null>(null);
  const [dragging, setDragging] = useState<{ from: number; over: number; after: boolean } | null>(null);
  const [notesOpen, setNotesOpen] = useState(true);
  const [stageW, setStageW] = useState(720);
  const [narrow, setNarrow] = useState(false);

  const deckRef = useRef<Deck | null>(null);
  const baseRef = useRef(0);
  const pendingRef = useRef<DeckOp[]>([]);
  const savingRef = useRef(false);
  const undoRef = useRef<Deck[]>([]);
  const redoRef = useRef<Deck[]>([]);
  const saveTimer = useRef<number | undefined>(undefined);
  const flashTimer = useRef<number | undefined>(undefined);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const sorterRef = useRef<HTMLDivElement | null>(null);

  const show = useCallback((s: string) => {
    setFlash(s);
    window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(f => (f === s ? null : f)), 4000);
  }, []);

  const setDeck = useCallback((d: Deck) => { deckRef.current = d; setDeckState(d); }, []);

  const adopt = useCallback((d: CanvasDoc) => {
    setDoc(d);
    baseRef.current = d.tabs?.[0]?.version ?? d.version;
    try {
      const parsed = parseDeck(d.tabs?.[0]?.content ?? d.content);
      setDeck(parsed);
      setCurrent(cur => (cur && parsed.slides.some(s => s.id === cur) ? cur : parsed.slides[0]?.id ?? null));
    } catch (err) { setLoadError(message(err)); }
  }, [setDeck]);

  useEffect(() => {
    let live = true;
    host.get(id).then(d => { if (live) adopt(d); }, err => { if (live) setLoadError(message(err)); });
    return () => { live = false; };
  }, [host, id, adopt]);

  // ── Save ──
  const save = useCallback(async (): Promise<void> => {
    if (savingRef.current || !pendingRef.current.length || !deckRef.current) return;
    savingRef.current = true;
    setSaving(true);
    const sent = pendingRef.current.length;
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const r = await host.save(id, serializeDeck(deckRef.current!), baseRef.current, 'Edited the slides');
        if (r.ok) {
          setDoc(r.canvas);
          baseRef.current = r.canvas.tabs?.[0]?.version ?? r.canvas.version;
          pendingRef.current = pendingRef.current.slice(sent);
          setDirty(pendingRef.current.length > 0);
          break;
        }
        const re = replayDeck(parseDeck(r.canvas.tabs?.[0]?.content ?? r.canvas.content), pendingRef.current);
        setDoc(r.canvas);
        baseRef.current = r.canvas.tabs?.[0]?.version ?? r.canvas.version;
        setDeck(re.deck);
        show(re.skipped ? `AICO changed the deck — ${re.skipped} of your edits were on slides it removed` : 'AICO changed the deck — your edits are kept on top');
      }
    } catch (err) {
      show(`Not saved: ${message(err)}`);
    } finally {
      savingRef.current = false;
      setSaving(false);
      if (pendingRef.current.length) { window.clearTimeout(saveTimer.current); saveTimer.current = window.setTimeout(() => { void save(); }, SAVE_MS); }
    }
  }, [host, id, setDeck, show]);

  useEffect(() => () => {
    window.clearTimeout(saveTimer.current);
    if (pendingRef.current.length && deckRef.current && !savingRef.current) {
      void host.save(id, serializeDeck(deckRef.current), baseRef.current, 'Edited the slides').catch(() => undefined);
    }
  }, [host, id]);

  // ── Live: the agent's writes ──
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
        if (last?.author !== 'user') show(`AICO updated the deck — version ${v}`);
        return;
      }
      if (savingRef.current) return;
      const re = replayDeck(parseDeck(d.tabs?.[0]?.content ?? d.content), pendingRef.current);
      setDoc(d);
      baseRef.current = v;
      setDeck(re.deck);
      show('AICO changed the deck — your edits are kept on top');
      void save();
    }, () => undefined);
  }), [host, id, adopt, save, setDeck, show]);

  // ── Changing it ──
  const apply = useCallback((op: DeckOp | DeckOp[], opts: { quiet?: boolean } = {}): boolean => {
    const cur = deckRef.current;
    if (!cur) return false;
    const ops = Array.isArray(op) ? op : [op];
    let next = cur;
    try { for (const o of ops) next = applyDeckOp(next, o); } catch (err) { if (!opts.quiet) show(message(err)); return false; }
    undoRef.current = [...undoRef.current.slice(-79), cur];
    redoRef.current = [];
    pendingRef.current.push(...ops);
    setDeck(next);
    setDirty(true);
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => { void save(); }, SAVE_MS);
    return true;
  }, [save, setDeck, show]);

  const undo = useCallback((redo = false) => {
    const from = redo ? redoRef.current : undoRef.current;
    const to = redo ? undoRef.current : redoRef.current;
    const snap = from.pop();
    if (!snap || !deckRef.current) return;
    to.push(deckRef.current);
    pendingRef.current.push({ op: 'replace', deck: snap });
    setDeck(snap);
    setCurrent(cur => (cur && snap.slides.some(s => s.id === cur) ? cur : snap.slides[0]?.id ?? null));
    setDirty(true);
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => { void save(); }, SAVE_MS);
  }, [save, setDeck]);

  /** Change fields of the current slide (loose input, normalised like the agent's). */
  const patch = useCallback((fields: Record<string, unknown>) => {
    const d = deckRef.current;
    const s = d?.slides.find(x => x.id === current);
    if (!d || !s) return;
    try { apply({ op: 'set', slide: normalizeSlide(fields, s.id, s) }, { quiet: true }); } catch (err) { show(message(err)); }
  }, [apply, current, show]);

  // ── Layout of the editor ──
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = (): void => {
      setNarrow(el.clientWidth < 980);
      const stage = stageRef.current;
      if (stage) setStageW(Math.max(240, Math.min(stage.clientWidth - 32, ((stage.clientHeight - 24) * (deckRef.current?.aspect === '4:3' ? 4 / 3 : 16 / 9)))));
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    if (stageRef.current) ro.observe(stageRef.current);
    measure();
    return () => ro.disconnect();
  }, [deck === null, notesOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  const layouts: SlideLayout[] = useMemo(() => (deck ? layoutDeck(deck, { draft: true }) : []), [deck]);
  const index = deck ? Math.max(0, deck.slides.findIndex(s => s.id === current)) : 0;
  const slide: Slide | undefined = deck?.slides[index];
  const problems: Problem[] = useMemo(() => layouts.flatMap(l => l.problems), [layouts]);
  const slideProblems = problems.filter(p => p.slide === slide?.id);
  const theme = deckTheme(deck?.theme);

  // ── Slide actions ──
  const select = (i: number): void => { const s = deckRef.current?.slides[i]; if (s) setCurrent(s.id); };
  const addSlide = (layout: DeckLayout): void => {
    const d = deckRef.current;
    if (!d) return;
    const s = blankSlide(layout, nextSlideId(d));
    if (apply({ op: 'insert', at: index + 1, slide: s })) setCurrent(s.id);
    setMenu(null);
  };
  const duplicate = (sid = current): void => {
    const d = deckRef.current;
    if (!d || !sid) return;
    try {
      const { slide: copy } = duplicateSlide(d, sid);
      const at = d.slides.findIndex(s => s.id === sid) + 1;
      if (apply({ op: 'insert', at, slide: copy })) setCurrent(copy.id);
    } catch (err) { show(message(err)); }
  };
  const remove = (sid = current): void => {
    const d = deckRef.current;
    if (!d || !sid) return;
    if (d.slides.length <= 1) { show('A deck keeps at least one slide'); return; }
    const at = d.slides.findIndex(s => s.id === sid);
    if (apply({ op: 'delete', id: sid })) setCurrent(d.slides[at + 1]?.id ?? d.slides[at - 1]?.id ?? null);
  };
  const move = (sid: string, to: number): void => { apply({ op: 'move', id: sid, to }); };

  const onSorterKey = (e: React.KeyboardEvent): void => {
    if (!deck || !slide) return;
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      if (e.altKey) move(slide.id, Math.max(0, Math.min(deck.slides.length - 1, index + dir)));
      else select(Math.max(0, Math.min(deck.slides.length - 1, index + dir)));
    } else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); remove(); }
    else if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicate(); }
  };

  const onRootKey = (e: React.KeyboardEvent): void => {
    const mod = e.ctrlKey || e.metaKey;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement).tagName);
    if (e.key === 'F5' || (mod && e.key === 'Enter')) { e.preventDefault(); setPresenting({ at: e.shiftKey ? index : 0, presenter: false }); return; }
    if (typing) return;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(e.shiftKey); }
    else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); undo(true); }
    else if (e.key === 'Escape') setMenu(null);
  };

  const exportAs = async (format: 'pptx' | 'pdf' | 'png'): Promise<void> => {
    setMenu(null);
    if (!host.exportFile) { show('Export needs the AICO engine'); return; }
    if (dirty) await save();
    show(`Exporting ${format.toUpperCase()}…`);
    try {
      const { blob, name } = await host.exportFile(id, format);
      const where = await saveBlob(name, blob, format);
      if (where) show(where === 'downloaded' ? `Downloaded ${name}` : `Saved to ${where}`);
    } catch (err) { show(`Export failed: ${message(err)}`); }
  };

  const renameDoc = async (t: string): Promise<void> => {
    setTitleEdit(null);
    const clean = t.trim();
    if (!clean || !host.rename || clean === doc?.title) return;
    try { setDoc(await host.rename(id, clean)); } catch (err) { show(message(err)); }
  };

  const choosePicture = async (): Promise<void> => {
    const file = await pickImage();
    if (!file) return;
    try { patch({ image: { src: await pictureDataUrl(file), alt: file.name.replace(/\.[a-z0-9]+$/i, '') } }); } catch (err) { show(message(err)); }
  };

  if (loadError) return <div className="aw adk" data-variant={variant}><div className="adk-empty">This deck could not be opened: {loadError}</div></div>;
  if (!deck || !doc) return <div className="aw adk" data-variant={variant}><div className="adk-empty">Opening {initial?.title ?? 'the deck'}…</div></div>;

  if (presenting) {
    return <DeckPresent deck={deck} start={presenting.at} presenter={presenting.presenter} onExit={(at) => { setPresenting(null); select(at); }} />;
  }

  const type = deckTypeById(deck.type);
  const errors = problems.filter(p => p.severity === 'error').length;
  const thumbW = narrow ? 112 : 148;

  return (
    <div className="aw adk" data-variant={variant} data-narrow={narrow ? '' : undefined} ref={rootRef} onKeyDown={onRootKey}>
      <div className="adk-head">
        <CvIcon name="page" size={16} className="adk-kind" />
        {titleEdit !== null ? (
          <input className="adk-title-input" autoFocus value={titleEdit} aria-label="Deck title" onChange={e => setTitleEdit(e.target.value)}
            onBlur={() => void renameDoc(titleEdit)} onKeyDown={(e) => { if (e.key === 'Enter') void renameDoc(titleEdit); if (e.key === 'Escape') setTitleEdit(null); }} />
        ) : (
          <button className="adk-title" title={host.rename ? 'Rename' : undefined} onClick={() => host.rename && setTitleEdit(doc.title)}>{doc.title}</button>
        )}
        <span className="adk-status">{flash ?? (saving ? 'Saving…' : dirty ? 'Edited' : `${deck.slides.length} slides · version ${doc.tabs?.[0]?.version ?? doc.version}`)}</span>
        {errors > 0 && <span className="adk-badge-err" title={problemLines(problems.filter(p => p.severity === 'error')).join('\n')}>{errors} to fix</span>}
        <span className="adk-spacer" />
        <div className="adk-menu-wrap">
          <button className="aw-btn adk-btn" onClick={() => setMenu(menu === 'theme' ? null : 'theme')} aria-haspopup="dialog">Theme: {theme.name}</button>
          {menu === 'theme' && (
            <div className="adk-pop adk-themes" role="dialog" aria-label="Themes">
              <div className="adk-pop-row">
                <label>Shape <select value={deck.aspect} onChange={e => apply({ op: 'meta', patch: { aspect: e.target.value as Deck['aspect'] } })}><option value="16:9">16:9</option><option value="4:3">4:3</option></select></label>
                <label>Footer <input value={deck.footer ?? ''} placeholder="e.g. Company · Confidential" onChange={e => apply({ op: 'meta', patch: { footer: e.target.value } }, { quiet: true })} /></label>
                <label className="adk-check"><input type="checkbox" checked={deck.slideNumbers !== false} onChange={e => apply({ op: 'meta', patch: { slideNumbers: e.target.checked } })} /> Slide numbers</label>
              </div>
              <div className="adk-theme-grid">
                {DECK_THEMES.map(t => (
                  <button key={t.id} className={`adk-theme${t.id === theme.id ? ' is-on' : ''}`} title={t.description} onClick={() => apply({ op: 'meta', patch: { theme: t.id } })}>
                    <DeckSlide deck={{ ...deck, theme: t.id, slides: [deck.slides.find(s => s.layout === 'title') ?? { id: 'p', layout: 'title', title: doc.title }] }} index={0} width={150} />
                    <span>{t.name}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="adk-menu-wrap">
          <button className="aw-btn adk-btn" onClick={() => setPresenting({ at: index, presenter: false })} title="Present from this slide (F5 from the start)"><CvIcon name="fullscreen" size={13} /> Present</button>
        </div>
        <button className="aw-btn adk-btn" onClick={() => setPresenting({ at: index, presenter: true })} title="Presenter view: notes, next slide, timer">Presenter view</button>
        <div className="adk-menu-wrap">
          <button className="aw-btn adk-btn" onClick={() => setMenu(menu === 'export' ? null : 'export')} aria-haspopup="menu"><CvIcon name="download" size={13} /> Export</button>
          {menu === 'export' && (
            <div className="adk-pop adk-menu" role="menu">
              <button role="menuitem" onClick={() => void exportAs('pptx')}>PowerPoint (.pptx) — editable</button>
              <button role="menuitem" onClick={() => void exportAs('pdf')}>PDF — one slide per page</button>
              <button role="menuitem" onClick={() => void exportAs('png')}>PNG images (.zip)</button>
            </div>
          )}
        </div>
        {host.create && (
          <div className="adk-menu-wrap">
            <button className="aw-icon-btn" title="New presentation" aria-label="New presentation" onClick={() => setMenu(menu === 'new' ? null : 'new')}><CvIcon name="plus" size={15} /></button>
            {menu === 'new' && <NewDeck host={host} onClose={() => setMenu(null)} onMade={(ref) => { setMenu(null); openOther?.(ref); }} />}
          </div>
        )}
        {onClose && <button className="aw-icon-btn" onClick={onClose} title="Close" aria-label="Close the deck"><CvIcon name="close" size={16} /></button>}
      </div>

      <div className="adk-body">
        <div className="adk-sorter" ref={sorterRef} tabIndex={0} role="listbox" aria-label="Slides" onKeyDown={onSorterKey}>
          {deck.slides.map((s, i) => {
            const l = layouts[i]!;
            const errs = l.problems.filter(p => p.severity === 'error').length;
            const drop = dragging && dragging.over === i ? (dragging.after ? ' drop-after' : ' drop-before') : '';
            return (
              <div key={s.id} role="option" aria-selected={s.id === slide?.id} aria-label={`Slide ${i + 1}: ${slideText(s).slice(0, 80)}`}
                className={`adk-thumb${s.id === slide?.id ? ' is-on' : ''}${drop}`} draggable
                onClick={() => setCurrent(s.id)}
                onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', s.id); setDragging({ from: i, over: i, after: false }); }}
                onDragOver={(e) => {
                  e.preventDefault();
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  const after = e.clientY > r.top + r.height / 2;
                  setDragging(d => (d && (d.over !== i || d.after !== after) ? { ...d, over: i, after } : d));
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragging) { const to = dropIndex(dragging.from, dragging.over, dragging.after); if (to !== dragging.from) move(deck.slides[dragging.from]!.id, to); }
                  setDragging(null);
                }}
                onDragEnd={() => setDragging(null)}>
                <span className="adk-thumb-n">{i + 1}</span>
                <DeckSlide deck={deck} index={i} width={thumbW} layout={l} />
                {errs > 0 && <span className="adk-thumb-err" title={problemLines(l.problems).join('\n')}>!</span>}
                {isPending(s) && <span className="adk-thumb-plan">planned</span>}
                <span className="adk-thumb-tools">
                  <button className="aw-icon-btn" title="Duplicate (Ctrl+D)" aria-label="Duplicate slide" onClick={(e) => { e.stopPropagation(); duplicate(s.id); }}><CvIcon name="copy" size={12} /></button>
                  <button className="aw-icon-btn" title="Delete (Del)" aria-label="Delete slide" onClick={(e) => { e.stopPropagation(); remove(s.id); }}><CvIcon name="trash" size={12} /></button>
                </span>
              </div>
            );
          })}
          <div className="adk-menu-wrap adk-add-wrap">
            <button className="aw-btn adk-add" onClick={() => setMenu(menu === 'add' ? null : 'add')}><CvIcon name="plus" size={13} /> Slide</button>
            {menu === 'add' && <LayoutPicker deck={deck} onPick={addSlide} />}
          </div>
        </div>

        <div className="adk-main">
          <div className="adk-stage" ref={stageRef}>
            {slide && <DeckSlide deck={deck} index={index} width={stageW} draft layout={layouts[index]} onField={f => setFocusField(`${f}:${Date.now()}`)} className="adk-stage-slide" />}
          </div>
          {slideProblems.length > 0 && (
            <ul className="adk-problems" aria-label="Layout problems on this slide">
              {slideProblems.map((p, i) => <li key={i} className={p.severity === 'error' ? 'is-err' : 'is-warn'}>{p.message}</li>)}
            </ul>
          )}
          <div className={`adk-notes${notesOpen ? '' : ' is-closed'}`}>
            <button className="adk-notes-toggle" onClick={() => setNotesOpen(o => !o)} aria-expanded={notesOpen}>Speaker notes {notesOpen ? '▾' : '▸'}</button>
            {notesOpen && slide && (
              <Field label="Speaker notes" value={slide.notes ?? ''} multiline rows={3} placeholder="What you will say on this slide — shown in presenter view and in PowerPoint's notes"
                onChange={v => patch({ notes: v || null })} focusKey="notes" focused={focusField} />
            )}
          </div>
        </div>

        {slide && (
          <Inspector key={slide.id} slide={slide} deckType={type?.title} maxBullets={type?.maxBullets ?? 6} focus={focusField}
            patch={patch} choosePicture={() => void choosePicture()} layoutMenu={menu === 'layout'} toggleLayoutMenu={() => setMenu(menu === 'layout' ? null : 'layout')}
            pickLayout={(l) => { patch({ layout: l }); setMenu(null); }} deck={deck} />
        )}
      </div>
    </div>
  );
}

function LayoutPicker({ deck, onPick }: { deck: Deck; onPick: (l: DeckLayout) => void }): React.ReactElement {
  return (
    <div className="adk-pop adk-layouts" role="dialog" aria-label="Layouts">
      {LAYOUTS.map(l => (
        <button key={l.id} className="adk-layout" title={l.hint} onClick={() => onPick(l.id)}>
          <DeckSlide deck={{ ...deck, slides: [blankSlide(l.id, 'preview')] }} index={0} width={128} />
          <span>{l.label}</span>
        </button>
      ))}
    </div>
  );
}

function Inspector({ slide, deck, deckType, maxBullets, focus, patch, choosePicture, layoutMenu, toggleLayoutMenu, pickLayout }: {
  slide: Slide; deck: Deck; deckType?: string; maxBullets: number; focus: string | null;
  patch: (f: Record<string, unknown>) => void; choosePicture: () => void;
  layoutMenu: boolean; toggleLayoutMenu: () => void; pickLayout: (l: DeckLayout) => void;
}): React.ReactElement {
  const info = layoutInfo(slide.layout);
  const has = (f: keyof Slide): boolean => info.fields.includes(f);
  const [chartType, setChartType] = useState<DeckChartType>(slide.chart?.type ?? 'column');
  const [unit, setUnit] = useState(slide.chart?.unit ?? '');
  const chartText = useRef(chartToText(slide.chart));
  const fp = { focused: focus };
  return (
    <aside className="adk-inspector" aria-label="Slide content">
      <div className="adk-menu-wrap">
        <button className="aw-btn adk-layout-btn" onClick={toggleLayoutMenu} aria-haspopup="dialog">Layout: {info.label} ▾</button>
        {layoutMenu && <LayoutPicker deck={deck} onPick={pickLayout} />}
      </div>
      {isPending(slide) && <div className="adk-plan">Planned: {slide.intent}</div>}
      {(has('title') || slide.title) && <Field label="Title" value={slide.title ?? ''} onChange={v => patch({ title: v || null })} focusKey="title" {...fp} />}
      {has('subtitle') && <Field label="Subtitle" value={slide.subtitle ?? ''} onChange={v => patch({ subtitle: v || null })} focusKey="subtitle" {...fp} />}
      {has('quote') && <Field label="Quote" multiline rows={4} value={slide.quote ?? ''} onChange={v => patch({ quote: v || null })} focusKey="quote" {...fp} />}
      {has('attribution') && <Field label="Attribution" value={slide.attribution ?? ''} onChange={v => patch({ attribution: v || null })} focusKey="attribution" {...fp} />}
      {has('body') && <Field label={slide.layout === 'title' || slide.layout === 'closing' ? 'Presenter / contact line' : slide.layout === 'kpi' ? 'Commentary' : 'Lead line'} multiline rows={2} value={slide.body ?? ''} onChange={v => patch({ body: v || null })} focusKey="body" {...fp} />}
      {has('bullets') && (
        <Field label={slide.layout === 'agenda' ? 'Agenda items' : slide.layout === 'chart' || slide.layout === 'diagram' ? 'Takeaways' : 'Bullets'} multiline rows={6}
          hint={`one per line, two spaces = sub-point, **bold** · up to ${slide.layout === 'agenda' ? 8 : slide.layout === 'chart' || slide.layout === 'diagram' ? 4 : maxBullets}${deckType ? ` for a ${deckType.toLowerCase()}` : ''}`}
          value={bulletsToText(slide.bullets)} onChange={v => patch({ bullets: textToBullets(v) })} focusKey="bullets" {...fp} />
      )}
      {(['left', 'right'] as const).filter(k => has(k)).map(k => (
        <fieldset key={k} className="adk-group">
          <legend>{k === 'left' ? 'Left' : 'Right'}{slide.layout === 'comparison' ? ' card' : ' column'}</legend>
          <Field label="Heading" value={slide[k]?.heading ?? ''} onChange={v => patch({ [k]: { ...slide[k], heading: v } })} focusKey={k} {...fp} />
          <Field label="Bullets" multiline rows={4} hint="one per line" value={bulletsToText(slide[k]?.bullets)} onChange={v => patch({ [k]: { ...slide[k], bullets: textToBullets(v) ?? undefined } })} />
        </fieldset>
      ))}
      {has('image') && (
        <fieldset className="adk-group">
          <legend>Picture</legend>
          <div className="adk-row">
            <button className="aw-btn adk-btn" onClick={choosePicture}><CvIcon name="image" size={13} /> Choose…</button>
            {slide.image && <button className="aw-btn adk-btn" onClick={() => patch({ image: null })}>Remove</button>}
          </div>
          <Field label="Or a project file (shown in exports)" value={slide.image?.src.startsWith('data:') ? '' : slide.image?.src ?? ''} placeholder="assets/photo.jpg"
            onChange={v => patch({ image: v.trim() ? { ...slide.image, src: v } : null })} focusKey="image" {...fp} />
          <Field label="Description (alt text)" value={slide.image?.alt ?? ''} onChange={v => slide.image && patch({ image: { ...slide.image, alt: v } })} />
        </fieldset>
      )}
      {has('chart') && (
        <fieldset className="adk-group">
          <legend>Chart</legend>
          {slide.chart?.echarts ? <p className="adk-hint">This chart is an ECharts option the agent wrote; ask AICO to change it, or type data below to replace it.</p> : null}
          <div className="adk-row">
            <select value={chartType} aria-label="Chart type" onChange={(e) => { const t = e.target.value as DeckChartType; setChartType(t); const c = textToChart(chartText.current, t, unit); if (c) patch({ chart: c }); }}>
              {CHART_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <input className="adk-unit" value={unit} placeholder="unit (%, £, ms)" aria-label="Unit" onChange={(e) => { setUnit(e.target.value); const c = textToChart(chartText.current, chartType, e.target.value); if (c) patch({ chart: c }); }} />
          </div>
          <Field label="Data" multiline rows={6} hint="first line: | Series 1 | Series 2; then Category | 10 | 12"
            value={chartToText(slide.chart)} onChange={(v) => { chartText.current = v; const c = textToChart(v, chartType, unit); if (c) patch({ chart: c }); }} focusKey="chart" {...fp} />
        </fieldset>
      )}
      {has('diagram') && <Field label="Diagram (Mermaid)" multiline rows={9} hint="flowchart LR, sequenceDiagram…" value={slide.diagram ?? ''} onChange={v => patch({ diagram: v || null })} focusKey="diagram" {...fp} />}
      {has('table') && <Field label="Table" multiline rows={8} hint="header line first, cells separated by |" value={tableToText(slide.table)} onChange={v => patch({ table: textToTable(v) })} focusKey="table" {...fp} />}
      {has('kpis') && <Field label="Big numbers" multiline rows={5} hint="value | label | change (up to 4)" value={kpisToText(slide.kpis)} onChange={v => patch({ kpis: textToKpis(v) })} focusKey="kpis" {...fp} />}
      {has('timeline') && <Field label="Milestones" multiline rows={6} hint="date | title | detail (up to 6)" value={timelineToText(slide.timeline)} onChange={v => patch({ timeline: textToTimeline(v) })} focusKey="timeline" {...fp} />}
      {has('source') && <Field label="Source / footnote" value={slide.source ?? ''} onChange={v => patch({ source: v || null })} focusKey="source" {...fp} />}
      <label className="adk-field">
        <span className="adk-field-label">Transition</span>
        <select value={slide.transition ?? 'none'} onChange={e => patch({ transition: e.target.value })}>
          <option value="none">None</option><option value="fade">Fade</option>
        </select>
      </label>
    </aside>
  );
}

/** "New presentation": a deck type's storyline and a theme, created as planned slides the person (or the agent) fills. */
function NewDeck({ host, onClose, onMade }: { host: CanvasHost; onClose: () => void; onMade: (ref: CanvasRef) => void }): React.ReactElement {
  const [type, setType] = useState(DECK_TYPES[0]!.id);
  const [themeId, setThemeId] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const t = deckTypeById(type)!;
  const create = async (): Promise<void> => {
    if (!host.create) return;
    setBusy(true);
    try {
      const deck: Deck = {
        v: 1, aspect: '16:9', theme: themeId || t.theme, type: t.id,
        slides: t.slides.map((s, i) => ({ id: `s${i + 1}`, layout: s.layout, ...(s.title ? { title: s.title } : {}), intent: s.intent })),
      };
      const made = await host.create({ title: title.trim() || t.title, content: serializeDeck(deck), kind: 'deck' });
      onMade({ id: made.id, title: made.title, kind: 'deck' });
    } catch (e) { setErr(message(e)); setBusy(false); }
  };
  return (
    <div className="adk-pop adk-new" role="dialog" aria-label="New presentation">
      <div className="adk-pop-title">New presentation</div>
      <Field label="Title" value={title} placeholder={t.title} onChange={setTitle} />
      <label className="adk-field"><span className="adk-field-label">Type</span>
        <select value={type} onChange={e => setType(e.target.value)}>{DECK_TYPES.map(d => <option key={d.id} value={d.id}>{d.title} — {d.description}</option>)}</select>
      </label>
      <label className="adk-field"><span className="adk-field-label">Theme</span>
        <select value={themeId} onChange={e => setThemeId(e.target.value)}>
          <option value="">{deckTheme(t.theme).name} (the type's own)</option>
          {DECK_THEMES.map(th => <option key={th.id} value={th.id}>{th.name} — {th.description}</option>)}
        </select>
      </label>
      <p className="adk-hint">{t.slides.length} planned slides: {t.slides.map(s => s.title || layoutInfo(s.layout).label).join(' · ')}</p>
      {err && <p className="adk-error">{err}</p>}
      <div className="adk-row"><span className="adk-spacer" /><button className="aw-btn" onClick={onClose}>Cancel</button><button className="aw-btn aw-btn-primary" disabled={busy} onClick={() => void create()}>Create</button></div>
    </div>
  );
}
