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
 * ## Ask AICO on a slide (ADR 0024, deck section)
 *
 * A ✦ on the element under the pointer, a right-click, a text selection (on
 * the slide or in a field), Ctrl+K / Ctrl+I, or a slide's ✦ in the sorter
 * opens the inline panel (`DeckInlineEdit`) for that element or slide. The
 * proposal is drawn on the stage while it is reviewed; Accept re-applies the
 * validated patch to the deck held here as one operation — one Ctrl+Z, one
 * saved version noted "AICO edit: …" — with an Undo beside it.
 *
 * @module shared/ui/canvas/DeckEditor
 */

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PartEditResponse } from './scoped-edit';
import type { InlineAccept, InlineScope } from './InlineEdit';
import {
  applyDeckPatch, deckScopes, elementAt, parseElement, resolveDeckTarget, selectionTarget, stableJson, withSlide, type DeckTarget,
} from './deck-scoped-edit';
import { DeckAsk } from './DeckInlineEdit';
import { onCanvasEvent, type CanvasDoc, type CanvasHost, type CanvasRef } from './host';
import { saveBlob, pickImage } from './export';
import { CvIcon } from './icons';
import {
  LAYOUTS, applyDeckOp, blankSlide, duplicateSlide, isPending, layoutInfo, nextSlideId, normalizeSlide, parseDeck, replayDeck,
  sampleInfographic, serializeDeck, slideText, type Deck, type DeckChartType, type DeckLayout, type DeckOp, type InfographicKind, type Slide,
} from './deck-model';
import { layoutDeck, layoutSlide, problemLines, type Problem, type SlideLayout } from './deck-layout';
import { DECK_THEMES, deckTheme } from './deck-themes';
import { DECK_TYPES, deckTypeById } from './deck-types';
import {
  bulletsToText, chartToText, dropIndex, kpisToText, tableToText, textToBullets, textToChart, textToKpis, textToTable,
  textToTimeline, timelineToText,
} from './deck-edit';
import { DeckPresent, DeckSlide } from './DeckSlide';
import { DesignPanel, ImagesField, InfographicFields, InfographicGallery, MakeVisualButton, PictureTools } from './DeckVisuals';
import { makeVisual } from './deck-design';
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

/** What the person selected in a field: its text and the selected range. */
type FieldSelection = { value: string; start: number; end: number } | null;

/**
 * A text field that keeps what the person typed (spaces, a half-written line) while the slide stores the normalised value.
 * With `onAsk` it carries a ✦ (Ask AICO about this element) and, while text is selected in it, an "Ask AICO" pill for the selection.
 */
function Field({ label, value, onChange, multiline, rows, placeholder, focusKey, focused, hint, onAsk, askKey }: {
  label: string; value: string; onChange: (v: string) => void; multiline?: boolean; rows?: number; placeholder?: string;
  focusKey?: string; focused?: string | null; hint?: string; onAsk?: (sel: FieldSelection) => void; askKey?: string;
}): React.ReactElement {
  const [local, setLocal] = useState(value);
  const [sel, setSel] = useState<{ start: number; end: number } | null>(null);
  const editing = useRef(false);
  const ref = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  useEffect(() => { if (!editing.current) setLocal(value); }, [value]);
  useEffect(() => {
    // `focused` is "field:stamp", so clicking the same part of the slide twice focuses it twice.
    if (focusKey && focused && focused.split(':')[0] === focusKey && ref.current) { ref.current.focus(); ref.current.scrollIntoView({ block: 'nearest' }); }
  }, [focused, focusKey]);
  const track = (e: React.SyntheticEvent<HTMLInputElement | HTMLTextAreaElement>): void => {
    const t = e.currentTarget;
    const s0 = t.selectionStart ?? 0;
    const e0 = t.selectionEnd ?? 0;
    setSel(onAsk && e0 > s0 && t.value.slice(s0, e0).trim() ? { start: s0, end: e0 } : null);
  };
  const props = {
    ref, value: local, placeholder, 'aria-label': label, spellCheck: true,
    onFocus: () => { editing.current = true; },
    onBlur: () => { editing.current = false; setLocal(value); setSel(null); },
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => { setLocal(e.target.value); onChange(e.target.value); },
    onSelect: track,
  };
  return (
    <label className="adk-field" data-ask-field={onAsk ? askKey ?? focusKey : undefined}>
      <span className="adk-field-label">
        {label}{hint ? <span className="adk-hint"> — {hint}</span> : null}
        {onAsk && value.trim() && (
          <button type="button" className="adk-ask-btn" title="Ask AICO to edit this (Ctrl+K)" aria-label={`Ask AICO to edit the ${label.toLowerCase()}`}
            onClick={(e) => { e.preventDefault(); onAsk(null); }}><CvIcon name="sparkle" size={11} /></button>
        )}
      </span>
      {multiline ? <textarea rows={rows ?? 4} {...props} /> : <input {...props} />}
      {onAsk && sel && (
        <button type="button" className="adk-ask-pill" onMouseDown={e => e.preventDefault()}
          onClick={(e) => { e.preventDefault(); onAsk({ value: local, ...sel }); setSel(null); }}>
          <CvIcon name="sparkle" size={12} /> Ask AICO
        </button>
      )}
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
  const [menu, setMenu] = useState<'theme' | 'layout' | 'add' | 'export' | 'new' | 'design' | null>(null);
  const [presenting, setPresenting] = useState<{ at: number; presenter: boolean } | null>(null);
  const [focusField, setFocusField] = useState<string | null>(null);
  const [titleEdit, setTitleEdit] = useState<string | null>(null);
  const [dragging, setDragging] = useState<{ from: number; over: number; after: boolean } | null>(null);
  const [notesOpen, setNotesOpen] = useState(true);
  const [stageW, setStageW] = useState(720);
  const [narrow, setNarrow] = useState(false);
  // Ask AICO (ADR 0024): the open panel, the proposal under review, the last accepted edit (for Undo), the ✦ under the pointer, a selection's pill.
  const [ask, setAsk] = useState<{ scopes: InlineScope[]; scope: InlineScope; seq: number; autoRun?: string } | null>(null);
  const [proposal, setProposal] = useState<PartEditResponse | null>(null);
  const [asked, setAsked] = useState<{ slideId: string; before: Slide; after: Slide; label: string } | null>(null);
  const [hover, setHover] = useState<{ elementId: string; x: number; y: number; cell?: { r: number; c: number } } | null>(null);
  const [pill, setPill] = useState<{ x: number; y: number; target: DeckTarget } | null>(null);
  const noteRef = useRef<string | null>(null);
  const lastElement = useRef<{ slideId: string; elementId: string } | null>(null);

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
        const r = await host.save(id, serializeDeck(deckRef.current!), baseRef.current, noteRef.current ?? 'Edited the slides');
        if (r.ok) {
          noteRef.current = null;
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

  // ── Ask AICO on a slide or an element (ADR 0024) ──
  const canAsk = Boolean(host.editPart);
  const scopesFor = useCallback((s: Slide, elementId: string, cell?: { r: number; c: number }): InlineScope[] => deckScopes(s, elementId, cell), []);
  const openAsk = useCallback((scopes: InlineScope[], autoRun?: string): void => {
    if (!canAsk || !scopes.length) return;
    const sid = scopes[0]!.target.slideId;
    if (sid) setCurrent(sid);
    setPill(null);
    setHover(null);
    setAsked(null);
    setProposal(null);
    setMenu(null);
    setAsk(cur => ({ scopes, scope: scopes[0]!, seq: (cur?.seq ?? 0) + 1, ...(autoRun ? { autoRun } : {}) }));
  }, [canAsk]);
  /** A field of the inspector (or the notes): the element, or the words selected in it. */
  const askField = useCallback((field: string, sel: FieldSelection): void => {
    const s = deckRef.current?.slides.find(x => x.id === current);
    if (!s) return;
    if (sel) {
      const t = selectionTarget(s, field, sel);
      if (t) { openAsk([{ label: 'Selection', target: t }, ...scopesFor(s, t.elementId!)]); return; }
    }
    openAsk(scopesFor(s, field));
  }, [current, openAsk, scopesFor]);
  const acceptAsk = useCallback((a: InlineAccept): string | null => {
    const d = deckRef.current;
    if (!d || !a.res.patch) return 'nothing to apply';
    // Re-applied to the deck as it is now: a field the person typed meanwhile is kept; the part itself must be as AICO read it.
    const r = resolveDeckTarget(d, a.target as DeckTarget);
    if (!r.ok) return r.error;
    if (r.part.before !== a.part.before) return 'that part changed since AICO read it — try again';
    const built = applyDeckPatch(d, r.part, a.res.patch);
    if (!built.ok) return built.error;
    const before = d.slides[r.part.index]!;
    noteRef.current = `AICO edit: ${a.instruction.slice(0, 120)}`;
    if (!apply({ op: 'set', slide: built.slide })) return 'could not apply the edit';
    window.clearTimeout(saveTimer.current);
    void save();
    setAsk(null);
    setProposal(null);
    setAsked({ slideId: before.id, before, after: built.slide, label: r.part.field === 'slide' ? `slide ${r.part.index + 1}` : `slide ${r.part.index + 1} · ${a.part.label.replace(/ ·.*$/, '')}` });
    return null;
  }, [apply, save]);
  const undoAsk = useCallback((): void => {
    const d = deckRef.current;
    const done = asked;
    setAsked(null);
    const cur = d?.slides.find(s => s.id === done?.slideId);
    if (!d || !done || !cur || stableJson(cur) !== stableJson(done.after)) { show('Could not undo — that slide changed since. The version history still has it.'); return; }
    noteRef.current = 'Undid an AICO edit';
    apply({ op: 'set', slide: done.before });
  }, [apply, asked, show]);
  useEffect(() => {
    if (!asked) return;
    const t = window.setTimeout(() => setAsked(null), 15_000);
    return () => window.clearTimeout(t);
  }, [asked]);
  // The panel belongs to its slide: choosing another slide closes it.
  useEffect(() => {
    if (ask && ask.scope.target.slideId && ask.scope.target.slideId !== current) { setAsk(null); setProposal(null); }
  }, [current]); // eslint-disable-line react-hooks/exhaustive-deps

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
  // While a proposal is reviewed, the stage draws the slide as it would be.
  const proposed = useMemo(() => {
    if (!deck || !proposal?.slide || proposal.part?.slideId !== slide?.id) return null;
    const d = withSlide(deck, index, proposal.slide as unknown as Slide);
    return { deck: d, layout: layoutSlide(d, index, { draft: true }) };
  }, [deck, proposal, slide?.id, index]);
  // The part being asked about is outlined on the stage.
  useLayoutEffect(() => {
    const st = stageRef.current;
    if (!st) return;
    st.querySelectorAll('[data-ask-on]').forEach(el => el.removeAttribute('data-ask-on'));
    const t = ask && !proposal ? ask.scope.target : null;
    const el = parseElement(t?.elementId);
    if (!t || !el || !slide || t.slideId !== slide.id) return;
    const mark = (n: Element | null | undefined): void => { n?.setAttribute('data-ask-on', ''); };
    if (el.field === 'slide') { mark(st.querySelector('.adk-stage-slide')); return; }
    let frames = Array.from(st.querySelectorAll(`[data-field="${el.field}"]`));
    if (el.field === 'body' && !frames.length) {
      // A bullets slide sets its lead line as the content frame's first paragraph.
      mark(st.querySelector('[data-field="bullets"][data-frame="Content"] > p'));
      return;
    }
    if (el.item) {
      const content = frames.find(f => /^(Content|Takeaways)$/.test((f as HTMLElement).dataset.frame ?? ''));
      if (content) { mark(content.children[el.item - 1 + ((content as HTMLElement).dataset.frame === 'Content' && slide.body?.trim() ? 1 : 0)]); return; }
      frames = frames.filter(f => new RegExp(` ${el.item}$`).test((f as HTMLElement).dataset.frame ?? ''));
    }
    frames.forEach(mark);
  });

  // ── Slide actions ──
  const select = (i: number): void => { const s = deckRef.current?.slides[i]; if (s) setCurrent(s.id); };
  const addSlide = (layout: DeckLayout, kind?: InfographicKind): void => {
    const d = deckRef.current;
    if (!d) return;
    const s = kind ? { ...blankSlide('infographic', nextSlideId(d)), infographic: sampleInfographic(kind) } : blankSlide(layout, nextSlideId(d));
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
    if (mod && !e.shiftKey && !e.altKey && (e.key.toLowerCase() === 'k' || e.key.toLowerCase() === 'i') && canAsk && slide && !(e.target as HTMLElement).closest('.aie')) {
      // Ask AICO: the field being typed in (or its selection), a selection on the slide, the element last pointed at, else the slide.
      e.preventDefault();
      const el = e.target as HTMLElement;
      const field = el.closest<HTMLElement>('[data-ask-field]')?.dataset.askField;
      if (field && (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement)) {
        const s0 = el.selectionStart ?? 0;
        const e0 = el.selectionEnd ?? 0;
        askField(field, e0 > s0 ? { value: el.value, start: s0, end: e0 } : null);
        return;
      }
      if (pill) { openAsk([{ label: 'Selection', target: pill.target }, ...scopesFor(slide, pill.target.elementId!)]); return; }
      const last = lastElement.current?.slideId === slide.id ? lastElement.current.elementId : 'slide';
      openAsk(scopesFor(slide, last));
      return;
    }
    if (typing) return;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(e.shiftKey); }
    else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); undo(true); }
    else if (e.key === 'Escape') { setMenu(null); setPill(null); }
  };

  /** The element under a point of the stage: its id, its box (a single bullet's own paragraph), and a table cell. */
  const pointAt = (target: HTMLElement): { elementId: string; rect: DOMRect; cell?: { r: number; c: number } } | null => {
    const f = target.closest<HTMLElement>('[data-field]');
    if (!f || !slide || !stageRef.current?.contains(f)) return null;
    const p = target.closest('p');
    const para = p && p.parentElement === f ? Array.from(f.children).indexOf(p) : undefined;
    const td = target.closest('td');
    const tr = td?.parentElement as HTMLTableRowElement | null;
    const cell = td && tr && f.dataset.field === 'table' ? { r: tr.rowIndex - 1, c: (td as HTMLTableCellElement).cellIndex } : undefined;
    const elementId = elementAt(slide, f.dataset.field!, f.dataset.frame, para);
    const box = p && para !== undefined && /^bullets\.\d+$|^body$/.test(elementId) && f.dataset.field === 'bullets' ? p : f;
    return { elementId, rect: box.getBoundingClientRect(), ...(cell ? { cell } : {}) };
  };
  const onStageMove = (e: React.MouseEvent): void => {
    if (!canAsk || ask || !slide) return;
    const hit = pointAt(e.target as HTMLElement);
    if (!hit) { if ((e.target as HTMLElement).closest('.adk-ask-dot')) return; setHover(null); return; }
    const st = stageRef.current!.getBoundingClientRect();
    const x = Math.round(hit.rect.right - st.left);
    const y = Math.round(hit.rect.top - st.top);
    lastElement.current = { slideId: slide.id, elementId: hit.elementId };
    setHover(h => (h && h.elementId === hit.elementId && h.x === x && h.y === y && h.cell?.r === hit.cell?.r && h.cell?.c === hit.cell?.c ? h : { elementId: hit.elementId, x, y, ...(hit.cell ? { cell: hit.cell } : {}) }));
  };
  const onStageMenu = (e: React.MouseEvent): void => {
    if (!canAsk || !slide || e.shiftKey) return;
    e.preventDefault();
    const hit = pointAt(e.target as HTMLElement);
    openAsk(scopesFor(slide, hit?.elementId ?? 'slide', hit?.cell));
  };
  const onStageMouseUp = (): void => {
    if (!canAsk || !slide || ask) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.anchorNode || !stageRef.current?.contains(sel.anchorNode)) { setPill(null); return; }
    const anchor = sel.anchorNode.nodeType === 1 ? sel.anchorNode as HTMLElement : sel.anchorNode.parentElement;
    const f = anchor?.closest<HTMLElement>('[data-field]');
    const text = sel.toString();
    const t = f && text.trim() ? selectionTarget(slide, f.dataset.field!, { text }) : null;
    if (!t) { setPill(null); return; }
    const r = sel.getRangeAt(0).getBoundingClientRect();
    const st = stageRef.current.getBoundingClientRect();
    setPill({ x: Math.round(r.left + r.width / 2 - st.left), y: Math.round(r.top - st.top), target: t });
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
          <button className="aw-btn adk-btn" onClick={() => setMenu(menu === 'design' ? null : 'design')} aria-haspopup="dialog" title="Design brief, brand colours and palette">Design</button>
          {menu === 'design' && <DesignPanel host={host} deck={deck} title={doc.title} meta={patch => apply({ op: 'meta', patch })} onClose={() => setMenu(null)} />}
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
                onContextMenu={canAsk ? (e) => { e.preventDefault(); openAsk(scopesFor(s, 'slide')); } : undefined}
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
                  {canAsk && !isPending(s) && (
                    <button className="aw-icon-btn adk-thumb-ask" title="Ask AICO to edit this slide" aria-label={`Ask AICO to edit slide ${i + 1}`}
                      onClick={(e) => { e.stopPropagation(); openAsk(scopesFor(s, 'slide')); }}><CvIcon name="sparkle" size={12} /></button>
                  )}
                  <button className="aw-icon-btn" title="Duplicate (Ctrl+D)" aria-label="Duplicate slide" onClick={(e) => { e.stopPropagation(); duplicate(s.id); }}><CvIcon name="copy" size={12} /></button>
                  <button className="aw-icon-btn" title="Delete (Del)" aria-label="Delete slide" onClick={(e) => { e.stopPropagation(); remove(s.id); }}><CvIcon name="trash" size={12} /></button>
                </span>
              </div>
            );
          })}
          <div className="adk-menu-wrap adk-add-wrap">
            <button className="aw-btn adk-add" onClick={() => setMenu(menu === 'add' ? null : 'add')}><CvIcon name="plus" size={13} /> Slide</button>
            {menu === 'add' && <LayoutPicker deck={deck} onPick={addSlide} onKind={k => addSlide('infographic', k)} />}
          </div>
        </div>

        <div className="adk-main">
          <div className={`adk-stage${proposed ? ' is-proposed' : ''}`} ref={stageRef} onMouseMove={onStageMove} onMouseLeave={() => setHover(null)}
            onContextMenu={onStageMenu} onMouseUp={onStageMouseUp}>
            {slide && (proposed
              ? <DeckSlide deck={proposed.deck} index={index} width={stageW} draft layout={proposed.layout} className="adk-stage-slide" />
              : <DeckSlide deck={deck} index={index} width={stageW} draft layout={layouts[index]} onField={(f) => { setFocusField(`${f}:${Date.now()}`); }} className="adk-stage-slide" />)}
            {proposed && <span className="adk-proposed-tag">Proposed by AICO — not applied yet</span>}
            {hover && !ask && slide && (
              <button type="button" className="adk-ask-dot" style={{ left: Math.max(4, hover.x - 26), top: Math.max(4, hover.y + 4) }}
                title="Ask AICO to edit this (Ctrl+K) — or right-click" aria-label="Ask AICO to edit this"
                onClick={(e) => { e.stopPropagation(); openAsk(scopesFor(slide, hover.elementId, hover.cell)); }}>
                <CvIcon name="sparkle" size={13} />
              </button>
            )}
            {pill && !ask && slide && (
              <button type="button" className="adk-ask-pill is-floating" style={{ left: pill.x, top: Math.max(4, pill.y - 34) }} onMouseDown={e => e.preventDefault()}
                onClick={() => openAsk([{ label: 'Selection', target: pill.target }, ...scopesFor(slide, pill.target.elementId!)])}>
                <CvIcon name="sparkle" size={12} /> Ask AICO
              </button>
            )}
            {asked && (
              <div className="aie-toast adk-ask-toast" role="status">
                <CvIcon name="sparkle" size={13} /> AICO edited {asked.label}
                <button type="button" className="aw-btn adoc-mini" onClick={undoAsk}><CvIcon name="undo" size={12} /> Undo</button>
              </div>
            )}
          </div>
          {ask && slide && (
            <div className="adk-ask">
              <DeckAsk key={`ask${ask.seq}`} host={host} canvasId={id} getDeck={() => deckRef.current} scopes={ask.scopes} {...(ask.autoRun ? { autoRun: ask.autoRun } : {})}
                saveFirst={async () => { if (pendingRef.current.length) await save(); return pendingRef.current.length === 0; }}
                onAccept={acceptAsk} onProposal={setProposal} onScope={scope => setAsk(cur => (cur ? { ...cur, scope } : cur))}
                onClose={() => { setAsk(null); setProposal(null); }} />
            </div>
          )}
          {slideProblems.length > 0 && (
            <ul className="adk-problems" aria-label="Layout problems on this slide">
              {slideProblems.map((p, i) => <li key={i} className={p.severity === 'error' ? 'is-err' : 'is-warn'}>{p.message}</li>)}
            </ul>
          )}
          <div className={`adk-notes${notesOpen ? '' : ' is-closed'}`}>
            <button className="adk-notes-toggle" onClick={() => setNotesOpen(o => !o)} aria-expanded={notesOpen}>Speaker notes {notesOpen ? '▾' : '▸'}</button>
            {notesOpen && slide && canAsk && !slide.notes?.trim() && !isPending(slide) && (
              <button type="button" className="aw-chip adk-notes-ask" onClick={() => openAsk(scopesFor(slide, 'notes'), 'Write speaker notes for this slide: what to say, 60–120 words, from the slide\'s own content — no new facts or figures.')}>
                <CvIcon name="sparkle" size={12} /> Write speaker notes
              </button>
            )}
            {notesOpen && slide && (
              <Field label="Speaker notes" value={slide.notes ?? ''} multiline rows={3} placeholder="What you will say on this slide — shown in presenter view and in PowerPoint's notes"
                onChange={v => patch({ notes: v || null })} focusKey="notes" focused={focusField} {...(canAsk ? { onAsk: (sel: FieldSelection) => askField('notes', sel) } : {})} />
            )}
          </div>
        </div>

        {slide && (
          <Inspector key={slide.id} slide={slide} deckType={type?.title} maxBullets={type?.maxBullets ?? 6} focus={focusField} {...(canAsk ? { onAsk: askField } : {})}
            patch={patch} choosePicture={() => void choosePicture()} layoutMenu={menu === 'layout'} toggleLayoutMenu={() => setMenu(menu === 'layout' ? null : 'layout')}
            pickLayout={(l) => { patch({ layout: l }); setMenu(null); }} deck={deck} host={host} />
        )}
      </div>
    </div>
  );
}

function LayoutPicker({ deck, onPick, onKind }: { deck: Deck; onPick: (l: DeckLayout) => void; onKind?: (k: InfographicKind) => void }): React.ReactElement {
  return (
    <div className="adk-pop adk-layouts" role="dialog" aria-label="Layouts">
      {LAYOUTS.filter(l => !onKind || l.id !== 'infographic').map(l => (
        <button key={l.id} className="adk-layout" title={l.hint} onClick={() => onPick(l.id)}>
          <DeckSlide deck={{ ...deck, slides: [blankSlide(l.id, 'preview')] }} index={0} width={128} />
          <span>{l.label}</span>
        </button>
      ))}
      {onKind && <div className="adv-gallery-title">Infographics</div>}
      {onKind && <div style={{ gridColumn: '1 / -1' }}><InfographicGallery deck={deck} onPick={onKind} /></div>}
    </div>
  );
}

function Inspector({ slide, deck, deckType, maxBullets, focus, patch, choosePicture, layoutMenu, toggleLayoutMenu, pickLayout, onAsk, host }: {
  slide: Slide; deck: Deck; deckType?: string; maxBullets: number; focus: string | null; onAsk?: (field: string, sel: FieldSelection) => void;
  patch: (f: Record<string, unknown>) => void; choosePicture: () => void;
  layoutMenu: boolean; toggleLayoutMenu: () => void; pickLayout: (l: DeckLayout) => void; host: CanvasHost;
}): React.ReactElement {
  const info = layoutInfo(slide.layout);
  const has = (f: keyof Slide): boolean => info.fields.includes(f);
  const [chartType, setChartType] = useState<DeckChartType>(slide.chart?.type ?? 'column');
  const [unit, setUnit] = useState(slide.chart?.unit ?? '');
  const chartText = useRef(chartToText(slide.chart));
  const fp = { focused: focus };
  /** Ask AICO from a field: the element it edits (`askKey`), or the words selected in it. */
  const ask = (field: string): { onAsk?: (sel: FieldSelection) => void; askKey?: string } => (onAsk ? { onAsk: sel => onAsk(field, sel), askKey: field } : {});
  return (
    <aside className="adk-inspector" aria-label="Slide content">
      <div className="adk-menu-wrap">
        <button className="aw-btn adk-layout-btn" onClick={toggleLayoutMenu} aria-haspopup="dialog">Layout: {info.label} ▾</button>
        {layoutMenu && <LayoutPicker deck={deck} onPick={pickLayout} onKind={(k) => {
          // A text slide becomes that infographic with every word kept; anything else switches kind (or starts from a sample).
          const next = makeVisual(slide, k);
          patch(next ? { bullets: null, left: null, right: null, kpis: null, timeline: null, ...next }
            : { layout: 'infographic', infographic: slide.infographic ? { ...slide.infographic, kind: k } : sampleInfographic(k) });
          pickLayout('infographic');
        }} />}
      </div>
      <MakeVisualButton slide={slide} patch={patch} />
      {isPending(slide) && <div className="adk-plan">Planned: {slide.intent}</div>}
      {(has('title') || slide.title) && <Field label="Title" value={slide.title ?? ''} onChange={v => patch({ title: v || null })} focusKey="title" {...fp} {...ask('title')} />}
      {has('subtitle') && <Field label="Subtitle" value={slide.subtitle ?? ''} onChange={v => patch({ subtitle: v || null })} focusKey="subtitle" {...fp} {...ask('subtitle')} />}
      {has('quote') && <Field label="Quote" multiline rows={4} value={slide.quote ?? ''} onChange={v => patch({ quote: v || null })} focusKey="quote" {...fp} {...ask('quote')} />}
      {has('attribution') && <Field label="Attribution" value={slide.attribution ?? ''} onChange={v => patch({ attribution: v || null })} focusKey="attribution" {...fp} {...ask('attribution')} />}
      {has('body') && <Field label={slide.layout === 'title' || slide.layout === 'closing' ? 'Presenter / contact line' : slide.layout === 'kpi' ? 'Commentary' : 'Lead line'} multiline rows={2} value={slide.body ?? ''} onChange={v => patch({ body: v || null })} focusKey="body" {...fp} {...ask('body')} />}
      {has('bullets') && (
        <Field label={slide.layout === 'agenda' ? 'Agenda items' : slide.layout === 'chart' || slide.layout === 'diagram' ? 'Takeaways' : 'Bullets'} multiline rows={6}
          hint={`one per line, two spaces = sub-point, **bold** · up to ${slide.layout === 'agenda' ? 8 : slide.layout === 'chart' || slide.layout === 'diagram' ? 4 : maxBullets}${deckType ? ` for a ${deckType.toLowerCase()}` : ''}`}
          value={bulletsToText(slide.bullets)} onChange={v => patch({ bullets: textToBullets(v) })} focusKey="bullets" {...fp} {...ask('bullets')} />
      )}
      {(['left', 'right'] as const).filter(k => has(k)).map(k => (
        <fieldset key={k} className="adk-group">
          <legend>{k === 'left' ? 'Left' : 'Right'}{slide.layout === 'comparison' ? ' card' : ' column'}</legend>
          <Field label="Heading" value={slide[k]?.heading ?? ''} onChange={v => patch({ [k]: { ...slide[k], heading: v } })} focusKey={k} {...fp} {...ask(k)} />
          <Field label="Bullets" multiline rows={4} hint="one per line" value={bulletsToText(slide[k]?.bullets)} onChange={v => patch({ [k]: { ...slide[k], bullets: textToBullets(v) ?? undefined } })} />
        </fieldset>
      ))}
      {has('image') && (
        <fieldset className="adk-group">
          <legend>Picture</legend>
          {host.deckMedia ? (
            // ADR 0025: search licensed pictures, project files, upload, generated art; the cut and side where the layout uses them.
            <PictureTools host={host} image={slide.image} onImage={img => patch({ image: img ?? null })} label={slide.layout === 'image-text' || slide.layout === 'quote' ? 'Picture' : 'Background or cut-out'}
              masks={['title', 'image-text', 'quote'].includes(slide.layout)} sides={slide.layout === 'title' || slide.layout === 'image-text'} />
          ) : (
            <>
              <div className="adk-row">
                <button className="aw-btn adk-btn" onClick={choosePicture}><CvIcon name="image" size={13} /> Choose…</button>
                {slide.image && <button className="aw-btn adk-btn" onClick={() => patch({ image: null })}>Remove</button>}
              </div>
              <Field label="Or a project file (shown in exports)" value={slide.image?.src.startsWith('data:') ? '' : slide.image?.src ?? ''} placeholder="assets/photo.jpg"
                onChange={v => patch({ image: v.trim() ? { ...slide.image, src: v } : null })} focusKey="image" {...fp} />
              <Field label="Description (alt text)" value={slide.image?.alt ?? ''} onChange={v => slide.image && patch({ image: { ...slide.image, alt: v } })} {...ask('image')} />
            </>
          )}
        </fieldset>
      )}
      {has('infographic') && onAsk && (slide.infographic?.items.length ?? 0) > 0 && (
        <button type="button" className="aw-chip adk-notes-ask" onClick={() => onAsk('infographic', null)}><CvIcon name="sparkle" size={12} /> Ask AICO about the infographic</button>
      )}
      {has('infographic') && <InfographicFields slide={slide} patch={patch} host={host} />}
      {has('images') && <ImagesField host={host} slide={slide} patch={patch} />}
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
            value={chartToText(slide.chart)} onChange={(v) => { chartText.current = v; const c = textToChart(v, chartType, unit); if (c) patch({ chart: c }); }} focusKey="chart" {...fp} {...ask('chart')} />
        </fieldset>
      )}
      {has('diagram') && <Field label="Diagram (Mermaid)" multiline rows={9} hint="flowchart LR, sequenceDiagram…" value={slide.diagram ?? ''} onChange={v => patch({ diagram: v || null })} focusKey="diagram" {...fp} {...ask('diagram')} />}
      {has('table') && <Field label="Table" multiline rows={8} hint="header line first, cells separated by |" value={tableToText(slide.table)} onChange={v => patch({ table: textToTable(v) })} focusKey="table" {...fp} {...ask('table')} />}
      {has('kpis') && <Field label="Big numbers" multiline rows={5} hint="value | label | change (up to 4)" value={kpisToText(slide.kpis)} onChange={v => patch({ kpis: textToKpis(v) })} focusKey="kpis" {...fp} {...ask('kpis')} />}
      {has('timeline') && <Field label="Milestones" multiline rows={6} hint="date | title | detail (up to 6)" value={timelineToText(slide.timeline)} onChange={v => patch({ timeline: textToTimeline(v) })} focusKey="timeline" {...fp} {...ask('timeline')} />}
      {has('source') && <Field label="Source / footnote" value={slide.source ?? ''} onChange={v => patch({ source: v || null })} focusKey="source" {...fp} {...ask('source')} />}
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
