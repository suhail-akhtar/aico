/**
 * One open canvas tab: loading it, autosaving the person's edits with the
 * version they were based on, and taking the agent's writes live.
 *
 * Shared by every way of editing a document — AICO Docs' block page, the
 * Markdown source mode and the code editor — so the saving rules are written
 * once. Those rules are the ones `CanvasEditor`'s header describes (autosave
 * 800 ms after the last change, a stale base answered 409 with the latest
 * document, nothing overwritten silently), made per tab for AICO Docs.
 *
 * ## Block edits survive the agent's writes
 *
 * The block page records each change as "this block's text was X, is now Y"
 * ({@link TrackedEdit}). When the agent writes while the person has unsaved
 * edits, those edits are re-applied to the agent's new text by their old
 * block text (`rebaseEdits`) — so the agent filling in section 4 while the
 * person fixes a typo in section 1 is not a conflict at all. Only when the
 * agent rewrote the very block being edited (the old text is gone) does the
 * conflict banner appear, naming that block. Edits typed in the source
 * textarea cannot be located that way and keep the old whole-document rule.
 *
 * @module shared/ui/canvas/useCanvasDoc
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  onCanvasEvent, tabsOf, type CanvasDoc, type CanvasHost, type CanvasTab, type CanvasVersion,
} from './host';
import { rebaseEdits, replaceBlock, splitBlocks, type BlockEdit } from './blocks';

export const AUTOSAVE_MS = 800;

/** A change to one block, keyed by the editing session that made it. */
export interface TrackedEdit extends BlockEdit {
  key: string;
  /** The block's index when the edit began — where "Keep mine" puts it if its old text is gone. */
  index: number;
}

export interface CanvasConflict {
  latest: CanvasDoc;
  /** The block edit that could not be re-applied, when the conflict is about one block. */
  failed?: TrackedEdit;
}

export interface CanvasDocController {
  doc: CanvasDoc | null;
  loadError: string | null;
  tabs: CanvasTab[];
  tabId: string;
  /** The open tab's version — what the next save is based on. */
  tabVersion: number;
  text: string;
  /** The text right now, including a change made earlier in this same event (state lags a render). */
  getText(): string;
  dirty: boolean;
  saving: boolean;
  saveError: string | null;
  conflict: CanvasConflict | null;
  flash: string | null;
  /** Set when the agent's write replaced the text: what it was before, for a brief highlight. */
  agentWrite: { before: string; at: number } | null;
  /** Replace the text. Pass `edit` when the change is one block's, so it can survive a concurrent write. */
  setText(text: string, edit?: TrackedEdit): void;
  save(note?: string): Promise<boolean>;
  keepMine(): Promise<void>;
  takeTheirs(): void;
  selectTab(tabId: string): Promise<void>;
  /** Adopt a document a tab operation returned. */
  adoptDoc(doc: CanvasDoc, tabId?: string): void;
  restore(v: CanvasVersion): Promise<boolean>;
  showFlash(text: string): void;
  clearSaveError(): void;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function tabOf(doc: CanvasDoc, tabId: string | undefined): CanvasTab {
  const all = tabsOf(doc);
  return all.find(t => t.id === tabId) ?? all[0]!;
}

/** Put an edit whose old text is gone back where its block was — "Keep mine" for that one block. */
function placeEdit(text: string, e: TrackedEdit): string {
  const blocks = splitBlocks(text);
  const b = blocks[e.index];
  if (b) return replaceBlock(text, b, e.after);
  return `${text.replace(/\s*$/, '')}\n\n${e.after}\n`;
}

export function useCanvasDoc(host: CanvasHost, id: string, opts: { paused?: boolean } = {}): CanvasDocController {
  const [doc, setDocState] = useState<CanvasDoc | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tabId, setTabId] = useState('');
  const [tabVersion, setTabVersion] = useState(0);
  const [text, setTextState] = useState('');
  const [baseContent, setBaseContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflictState] = useState<CanvasConflict | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [agentWrite, setAgentWrite] = useState<{ before: string; at: number } | null>(null);

  const docRef = useRef<CanvasDoc | null>(null);
  const tabRef = useRef('');
  const textRef = useRef('');
  const baseRef = useRef(0);
  const baseContentRef = useRef('');
  const savingRef = useRef(false);
  const recheckRef = useRef(false);
  const conflictRef = useRef<CanvasConflict | null>(null);
  const editsRef = useRef(new Map<string, TrackedEdit>());
  /** True once the text changed in a way no block edit describes (the source textarea). */
  const untrackedRef = useRef(false);
  const flashTimer = useRef<number | undefined>(undefined);

  const setDoc = useCallback((d: CanvasDoc) => { docRef.current = d; setDocState(d); }, []);
  const setConflict = useCallback((c: CanvasConflict | null) => { conflictRef.current = c; setConflictState(c); }, []);
  const setBase = useCallback((tab: CanvasTab, content = tab.content) => {
    baseRef.current = tab.version;
    setTabVersion(tab.version);
    baseContentRef.current = content;
    setBaseContent(content);
  }, []);

  const setText = useCallback((v: string, edit?: TrackedEdit) => {
    textRef.current = v;
    setTextState(v);
    if (!edit) { untrackedRef.current = true; return; }
    const prev = editsRef.current.get(edit.key);
    editsRef.current.set(edit.key, { ...edit, before: prev ? prev.before : edit.before, index: prev ? prev.index : edit.index });
  }, []);

  const showFlash = useCallback((s: string) => {
    setFlash(s);
    window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(f => (f === s ? null : f)), 3200);
  }, []);

  /** Make a document the baseline: what is shown, and what the next save builds on. */
  const adoptDoc = useCallback((d: CanvasDoc, want?: string) => {
    const tab = tabOf(d, want ?? tabRef.current);
    setDoc(d);
    tabRef.current = tab.id;
    setTabId(tab.id);
    setBase(tab);
    textRef.current = tab.content;
    setTextState(tab.content);
    editsRef.current.clear();
    untrackedRef.current = false;
  }, [setDoc, setBase]);

  // ── Load ──
  useEffect(() => {
    let live = true;
    host.get(id).then(d => { if (live) adoptDoc(d); }, err => { if (live) setLoadError(message(err)); });
    return () => { live = false; };
  }, [host, id, adoptDoc]);

  /**
   * A newer document arrived while the person has unsaved edits: re-apply
   * their block edits to it, or raise the conflict. Returns true when the
   * edits were carried over (and will autosave on top).
   */
  const resolveAgainst = useCallback((latest: CanvasDoc): boolean => {
    const tab = tabOf(latest, tabRef.current);
    const edits = [...editsRef.current.values()];
    if (!untrackedRef.current && edits.length) {
      const r = rebaseEdits(tab.content, edits);
      if (r.ok) {
        const before = baseContentRef.current;
        setDoc(latest);
        setBase(tab);
        textRef.current = r.text;
        setTextState(r.text);
        setAgentWrite({ before, at: Date.now() });
        return true;
      }
      setDoc(latest);
      // rebaseEdits hands back the very edit object it could not place.
      setConflict({ latest, failed: (r as { failed: BlockEdit }).failed as TrackedEdit });
      return false;
    }
    setDoc(latest);
    setConflict({ latest });
    return false;
  }, [setDoc, setBase, setConflict]);

  // ── Save ──
  const saveRef = useRef<(note?: string) => Promise<boolean>>(async () => false);
  const save = useCallback(async (note?: string): Promise<boolean> => {
    if (conflictRef.current || savingRef.current) return false;
    const content = textRef.current;
    if (content === baseContentRef.current) return true;
    savingRef.current = true;
    setSaving(true);
    const sent = new Map([...editsRef.current].map(([k, e]) => [k, e.after]));
    let again = false;
    try {
      const r = await host.save(id, content, baseRef.current, note, docRef.current?.tabs ? tabRef.current : undefined);
      if (r.ok) {
        const tab = tabOf(r.canvas, tabRef.current);
        setDoc(r.canvas);
        setBase(tab, content);
        setSaveError(null);
        // What was sent is now the base: an edit still open starts again from what was saved.
        for (const [k, after] of sent) {
          const now = editsRef.current.get(k);
          if (!now) continue;
          if (now.after === after) editsRef.current.delete(k);
          else editsRef.current.set(k, { ...now, before: after });
        }
        if (textRef.current === content) untrackedRef.current = false;
        return true;
      }
      again = resolveAgainst(r.canvas);
      if (again) showFlash('AICO changed other parts — your edits are kept');
      return false;
    } catch (err) {
      setSaveError(message(err));
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
      if (recheckRef.current) { recheckRef.current = false; void recheckRef2.current(); }
    }
  }, [host, id, setDoc, setBase, resolveAgainst, showFlash]);
  saveRef.current = save;

  useEffect(() => {
    if (text === baseContent || conflict || opts.paused) return;
    const t = window.setTimeout(() => { void save(); }, AUTOSAVE_MS);
    return () => window.clearTimeout(t);
  }, [text, baseContent, conflict, opts.paused, save]);

  // Leaving with edits still pending: send them, best effort.
  useEffect(() => () => {
    if (textRef.current !== baseContentRef.current && !conflictRef.current && !savingRef.current) {
      void host.save(id, textRef.current, baseRef.current, undefined, docRef.current?.tabs ? tabRef.current : undefined).catch(() => undefined);
    }
  }, [host, id]);

  // ── Live changes from the other side ──
  const recheck = useCallback(async (): Promise<void> => {
    let latest: CanvasDoc;
    try { latest = await host.get(id); } catch { return; }
    const tab = tabOf(latest, tabRef.current);
    if (tab.id !== tabRef.current) {
      // The open tab was deleted elsewhere: show the first one.
      adoptDoc(latest, tab.id);
      showFlash('That tab was removed');
      return;
    }
    if (tab.version <= baseRef.current) {
      // Another tab, the tab list or the title changed: refresh the chrome only.
      setDoc(latest);
      return;
    }
    if (savingRef.current) { recheckRef.current = true; return; }
    if (tab.content === textRef.current) {
      // Our own write, announced before its response arrived.
      setDoc(latest);
      setBase(tab);
      editsRef.current.clear();
      untrackedRef.current = false;
      return;
    }
    const pending = textRef.current !== baseContentRef.current;
    const mine = latest.versions.filter(v => (v.tab ?? 't1') === tab.id || !latest.tabs);
    const who = mine[mine.length - 1]?.author;
    if (!pending) {
      const before = textRef.current;
      adoptDoc(latest);
      if (who !== 'user') setAgentWrite({ before, at: Date.now() });
      showFlash(who === 'user' ? `Updated to version ${tab.version}` : `AICO updated it — version ${tab.version}`);
      return;
    }
    if (resolveAgainst(latest)) showFlash('AICO changed other parts — your edits are kept');
  }, [host, id, adoptDoc, setDoc, setBase, resolveAgainst, showFlash]);
  const recheckRef2 = useRef(recheck);
  recheckRef2.current = recheck;

  useEffect(() => onCanvasEvent((change) => {
    if (change.id !== id) return;
    const sid = host.sessionId();
    if (change.sessionId && sid && change.sessionId !== sid) return;
    // A newer revision with no new text is a settings/theme change (round 3): refresh the chrome, which now draws the theme.
    const newerRevision = typeof change.revision === 'number' && change.revision > (docRef.current?.revision ?? Infinity);
    if (!newerRevision && change.tabId && change.tabId === tabRef.current && typeof change.tabVersion === 'number' && change.tabVersion <= baseRef.current) return;
    if (!change.tabId && change.action !== 'tabs' && !docRef.current?.tabs && change.version <= baseRef.current) return;
    if (savingRef.current) { recheckRef.current = true; return; }
    void recheck();
  }), [host, id, recheck]);

  const keepMine = useCallback(async (): Promise<void> => {
    const c = conflictRef.current;
    if (!c) return;
    const tab = tabOf(c.latest, tabRef.current);
    let next = textRef.current;
    if (!untrackedRef.current && editsRef.current.size) {
      next = tab.content;
      for (const e of editsRef.current.values()) {
        const r = rebaseEdits(next, [e]);
        next = r.ok ? r.text : placeEdit(next, e);
      }
      // Every edit now sits in `next`; the next conflict starts from here.
      for (const e of editsRef.current.values()) editsRef.current.set(e.key, { ...e, before: e.after });
    }
    setDoc(c.latest);
    setBase(tab);
    setConflict(null);
    textRef.current = next;
    setTextState(next);
    if (await saveRef.current('Kept my edits over a newer version')) showFlash('Your edits are saved on top');
  }, [setDoc, setBase, setConflict, showFlash]);

  const takeTheirs = useCallback((): void => {
    const c = conflictRef.current;
    if (!c) return;
    setConflict(null);
    adoptDoc(c.latest);
    showFlash(`Showing version ${tabOf(c.latest, tabRef.current).version}`);
  }, [adoptDoc, setConflict, showFlash]);

  const selectTab = useCallback(async (next: string): Promise<void> => {
    if (next === tabRef.current) return;
    if (textRef.current !== baseContentRef.current && !(await saveRef.current())) return;
    let latest = docRef.current;
    try { latest = await host.get(id); } catch { /* switch on what we have */ }
    if (latest) adoptDoc(latest, next);
  }, [host, id, adoptDoc]);

  const restore = useCallback(async (v: CanvasVersion): Promise<boolean> => {
    if (textRef.current !== baseContentRef.current && !(await saveRef.current())) return false;
    try {
      const r = await host.restore(id, v.version, baseRef.current, docRef.current?.tabs ? tabRef.current : undefined);
      if (r.ok) {
        adoptDoc(r.canvas);
        showFlash(`Restored version ${v.version} (now version ${tabOf(r.canvas, tabRef.current).version})`);
        return true;
      }
      setDoc(r.canvas);
      setConflict({ latest: r.canvas });
      return false;
    } catch (err) {
      setSaveError(message(err));
      return false;
    }
  }, [host, id, adoptDoc, setDoc, setConflict, showFlash]);

  return {
    doc, loadError, tabs: doc ? tabsOf(doc) : [], tabId, tabVersion, text, getText: () => textRef.current, dirty: text !== baseContent, saving, saveError, conflict,
    flash, agentWrite, setText, save, keepMine, takeTheirs, selectTab, adoptDoc, restore, showFlash,
    clearSaveError: () => setSaveError(null),
  };
}
