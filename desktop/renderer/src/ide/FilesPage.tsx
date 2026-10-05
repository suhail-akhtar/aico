/**
 * Files: an explorer and a real code editor.
 *
 * Left, the project's tree (lazy, with the usual noise folders hidden), a
 * search-in-files panel, and quick open (Ctrl+P). Right, Monaco with tabs:
 * syntax for every common language, dirty markers, Ctrl+S to save, and live
 * reload when the file changes on disk — so when the agent edits a file you
 * have open, you see it happen. Images preview; Markdown previews with every
 * widget the chat can draw. "Ask AI" sends the file or the selection to a chat.
 *
 * @module desktop/renderer/ide/FilesPage
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MarkdownRenderer } from '@aico/ui';
import { useStore } from '@web/store';
import { useProjects } from '@/lib/projects';
import { invoke, on, desktop } from '@/desktop';
import { useDesk, toast, go } from '@/state/desk';
import { Icon } from '@/lib/icons';
import { basename, bytes, cls, dirname } from '@/lib/util';
import { MenuItem, MenuSep, Popover } from '@/shell/Popover';
import { Modal } from '@/shell/Modal';
import type { ViewProps } from '@/plugins/registry';
import { applyEditorTheme, languageFor, monaco } from './monaco';

interface Entry { name: string; path: string; dir: boolean; size: number; mtime: number }
interface OpenFile { path: string; model?: monaco.editor.ITextModel; savedVersion: number; dirty: boolean; kind: 'text' | 'image' | 'binary' | 'large'; dataUrl?: string; size: number; mtime?: number }

const IMAGE = /\.(png|jpe?g|gif|webp|bmp|ico|svg)$/i;

export function FilesPage({ params }: ViewProps): React.ReactElement {
  const project = useStore(s => s.project);
  const projects = useProjects();
  const fallback = params?.root || project || projects.find(p => !p.isWorkspace)?.path || '';
  const [root, setRoot] = useState(fallback);
  useEffect(() => { if (params?.root) setRoot(params.root); }, [params?.root]);
  if (!root) return <div className="flex flex-1 items-center justify-center text-aico-muted">Open a project to browse its files.</div>;
  return <Workbench key={root} root={root} setRoot={setRoot} openPath={params?.open} openLine={params?.line ? Number(params.line) : undefined} />;
}

function Workbench({ root, setRoot, openPath, openLine }: { root: string; setRoot: (r: string) => void; openPath?: string; openLine?: number }): React.ReactElement {
  const projects = useProjects();
  const [files, setFiles] = useState<OpenFile[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [side, setSide] = useState<'tree' | 'search'>('tree');
  const [quickOpen, setQuickOpen] = useState(false);
  const [preview, setPreview] = useState(false);
  const [treeVersion, setTreeVersion] = useState(0);
  const filesRef = useRef(files);
  filesRef.current = files;

  const open = useCallback(async (path: string, line?: number) => {
    const existing = filesRef.current.find(f => f.path === path);
    if (existing) { setActive(path); if (line) window.dispatchEvent(new CustomEvent('desk:reveal-line', { detail: line })); return; }
    try {
      if (IMAGE.test(path)) {
        const dataUrl = await invoke<string>('fs:readDataUrl', path);
        setFiles(fs => [...fs, { path, kind: 'image', dataUrl, savedVersion: 0, dirty: false, size: 0 }]);
      } else {
        const r = await invoke<{ binary: boolean; tooLarge: boolean; size: number; content: string; mtime?: number }>('fs:read', path);
        if (r.binary || r.tooLarge) {
          setFiles(fs => [...fs, { path, kind: r.binary ? 'binary' : 'large', savedVersion: 0, dirty: false, size: r.size }]);
        } else {
          const uri = monaco.Uri.file(path);
          const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(r.content, languageFor(path), uri);
          if (model.getValue() !== r.content) model.setValue(r.content);
          setFiles(fs => [...fs, { path, kind: 'text', model, savedVersion: model.getAlternativeVersionId(), dirty: false, size: r.size, mtime: r.mtime }]);
        }
      }
      setActive(path);
      if (line) setTimeout(() => window.dispatchEvent(new CustomEvent('desk:reveal-line', { detail: line })), 150);
    } catch (err) { toast.error(`Could not open ${basename(path)}`, (err as Error).message); }
  }, []);

  useEffect(() => { if (openPath) void open(openPath, openLine); }, [openPath, openLine, open]);

  const save = useCallback(async (path?: string) => {
    const f = filesRef.current.find(x => x.path === (path ?? active));
    if (!f?.model) return;
    try {
      const mtime = await invoke<number>('fs:write', f.path, f.model.getValue());
      const v = f.model.getAlternativeVersionId();
      setFiles(fs => fs.map(x => x.path === f.path ? { ...x, savedVersion: v, dirty: false, mtime } : x));
    } catch (err) { toast.error('Save failed', (err as Error).message); }
  }, [active]);

  const close = useCallback(async (path: string) => {
    const f = filesRef.current.find(x => x.path === path);
    if (f?.dirty && !(await desktop.dialog.confirm({ title: 'Unsaved changes', message: `Close ${basename(path)} without saving?`, ok: 'Close without saving', danger: true }))) return;
    f?.model?.dispose();
    setFiles(fs => {
      const next = fs.filter(x => x.path !== path);
      if (active === path) setActive(next[next.length - 1]?.path ?? null);
      return next;
    });
  }, [active]);

  // The disk changed: reload clean files, warn about dirty ones.
  useEffect(() => {
    void invoke('fs:watch', root);
    return on<{ root: string; paths: string[] }>('fs:changed', async (e) => {
      if (e.root !== root) return;
      setTreeVersion(v => v + 1);
      for (const p of e.paths) {
        const f = filesRef.current.find(x => x.path.toLowerCase() === p.toLowerCase());
        if (!f?.model) continue;
        const st = await invoke<{ exists: boolean; mtime: number }>('fs:stat', f.path);
        if (!st.exists || st.mtime === f.mtime) continue;
        if (f.dirty) { toast.warning(`${basename(f.path)} changed on disk`, 'You have unsaved edits; saving will overwrite the other version.'); continue; }
        const r = await invoke<{ content: string; mtime: number }>('fs:read', f.path);
        f.model.setValue(r.content);
        setFiles(fs => fs.map(x => x.path === f.path ? { ...x, savedVersion: f.model!.getAlternativeVersionId(), dirty: false, mtime: r.mtime } : x));
      }
    });
  }, [root]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p' && !e.shiftKey) { e.preventDefault(); setQuickOpen(true); }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); setSide('search'); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const current = files.find(f => f.path === active);
  const markDirty = useCallback((path: string, dirty: boolean) => setFiles(fs => fs.map(x => x.path === path && x.dirty !== dirty ? { ...x, dirty } : x)), []);

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex w-[280px] shrink-0 flex-col border-r border-aico-border-subtle bg-aico-sidebar">
        <div className="flex items-center gap-1 border-b border-aico-border-subtle px-2 py-1.5">
          <select className="select h-7 flex-1 py-0 text-[12.5px]" value={root} onChange={e => setRoot(e.target.value)} aria-label="Project">
            {projects.filter(p => p.exists).map(p => <option key={p.path} value={p.path}>{p.isWorkspace ? 'Workspace' : p.name}</option>)}
            {!projects.some(p => p.path === root) && <option value={root}>{basename(root)}</option>}
          </select>
          <button className={cls('icon-btn-sm', side === 'tree' && 'bg-aico-hover')} onClick={() => setSide('tree')} title="Explorer" aria-label="Explorer"><Icon name="folder" size={14} /></button>
          <button className={cls('icon-btn-sm', side === 'search' && 'bg-aico-hover')} onClick={() => setSide('search')} title="Search in files (Ctrl+Shift+F)" aria-label="Search in files"><Icon name="search" size={14} /></button>
          <button className="icon-btn-sm" onClick={() => setQuickOpen(true)} title="Quick open (Ctrl+P)" aria-label="Quick open"><Icon name="zap" size={14} /></button>
        </div>
        {side === 'tree' ? <Tree root={root} onOpen={p => void open(p)} active={active} version={treeVersion} onChanged={() => setTreeVersion(v => v + 1)} /> : <SearchPanel root={root} onOpen={(p, l) => void open(p, l)} />}
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-9 shrink-0 items-end overflow-x-auto border-b border-aico-border-subtle thin-scroll">
          {files.map(f => (
            <div key={f.path} className={cls('group flex h-9 max-w-[220px] shrink-0 items-center gap-1.5 border-r border-aico-border-subtle px-3 text-[12.5px]', f.path === active ? 'bg-aico-bg text-aico-primary' : 'bg-aico-sidebar text-aico-muted hover:text-aico-primary')}>
              <button className="flex min-w-0 items-center gap-1.5" onClick={() => setActive(f.path)} title={f.path}>
                <Icon name={f.kind === 'image' ? 'image' : 'file'} size={12} /><span className="truncate">{basename(f.path)}</span>
              </button>
              <button className="icon-btn-sm h-5 w-5" onClick={() => void close(f.path)} aria-label={`Close ${basename(f.path)}`}>
                {f.dirty ? <span className="h-2 w-2 rounded-full bg-aico-primary group-hover:hidden" /> : null}
                <Icon name="x" size={11} className={f.dirty ? 'hidden group-hover:block' : ''} />
              </button>
            </div>
          ))}
          <div className="flex-1" />
          {current?.kind === 'text' && (
            <div className="flex h-9 items-center gap-1 px-2">
              {languageFor(current.path) === 'markdown' && <button className={cls('btn-ghost btn-sm', preview && 'bg-aico-hover')} onClick={() => setPreview(p => !p)}><Icon name="eye" size={13} />Preview</button>}
              <AskAi file={current} root={root} />
              <button className="icon-btn-sm" onClick={() => void save()} disabled={!current.dirty} title="Save (Ctrl+S)" aria-label="Save"><Icon name="save" size={14} /></button>
            </div>
          )}
        </div>
        <div className="relative min-h-0 flex-1">
          {files.length === 0 && (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-aico-muted">
              <Icon name="code" size={30} />
              <div className="text-[13.5px]">Open a file from the explorer, or press <span className="kbd">Ctrl P</span></div>
            </div>
          )}
          {current?.kind === 'text' && current.model && !preview && <Editor file={current} onDirty={markDirty} onSave={save} />}
          {current?.kind === 'text' && current.model && preview && (
            <div className="h-full overflow-y-auto"><div className="transcript mx-auto max-w-column px-8 py-8"><MarkdownRenderer content={current.model.getValue()} /></div></div>
          )}
          {current?.kind === 'image' && <div className="flex h-full items-center justify-center overflow-auto bg-[repeating-conic-gradient(var(--aico-hover)_0_25%,transparent_0_50%)] bg-[length:20px_20px] p-6"><img src={current.dataUrl} alt={basename(current.path)} className="max-h-full max-w-full" /></div>}
          {(current?.kind === 'binary' || current?.kind === 'large') && (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-aico-muted">
              <Icon name="file" size={28} />
              <div className="text-[13.5px]">{current.kind === 'binary' ? 'A binary file' : 'Too large to edit here'} ({bytes(current.size)})</div>
              <button className="btn-outline btn-sm" onClick={() => void desktop.shell.openPath(current.path)}>Open with the system app</button>
            </div>
          )}
        </div>
      </div>
      <QuickOpen open={quickOpen} root={root} onClose={() => setQuickOpen(false)} onPick={p => { setQuickOpen(false); void open(p); }} />
    </div>
  );
}

function Editor({ file, onDirty, onSave }: { file: OpenFile; onDirty: (p: string, d: boolean) => void; onSave: (p?: string) => Promise<void> }): React.ReactElement {
  const host = useRef<HTMLDivElement>(null);
  const ed = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const mode = useDesk(s => s.mode);
  const codeFont = useDesk(s => s.prefs.codeFont);
  const views = useRef(new Map<string, monaco.editor.ICodeEditorViewState | null>());

  useEffect(() => {
    applyEditorTheme();
    const e = monaco.editor.create(host.current!, {
      model: null, automaticLayout: true, fontFamily: codeFont, fontSize: 13.5, lineHeight: 21,
      minimap: { enabled: true, renderCharacters: false }, smoothScrolling: true, cursorSmoothCaretAnimation: 'on',
      scrollBeyondLastLine: false, renderWhitespace: 'selection', bracketPairColorization: { enabled: true },
      guides: { bracketPairs: true, indentation: true }, stickyScroll: { enabled: true }, padding: { top: 8 },
      tabSize: 2, wordWrap: 'off', theme: 'aico',
    });
    ed.current = e;
    const reveal = (ev: Event): void => { const line = (ev as CustomEvent<number>).detail; e.revealLineInCenter(line); e.setPosition({ lineNumber: line, column: 1 }); e.focus(); };
    window.addEventListener('desk:reveal-line', reveal);
    return () => { window.removeEventListener('desk:reveal-line', reveal); e.dispose(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { applyEditorTheme(); }, [mode]);

  useEffect(() => {
    const e = ed.current;
    if (!e || !file.model) return;
    const prev = e.getModel();
    if (prev && prev !== file.model) views.current.set(prev.uri.fsPath, e.saveViewState());
    e.setModel(file.model);
    const vs = views.current.get(file.path);
    if (vs) e.restoreViewState(vs);
    e.focus();
    const sub = file.model.onDidChangeContent(() => onDirty(file.path, file.model!.getAlternativeVersionId() !== file.savedVersion));
    const cmd = e.addAction({ id: 'aico.save', label: 'Save', keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS], run: () => { void onSave(file.path); } });
    const ask = e.addAction({
      id: 'aico.ask', label: 'Ask AI about the selection', contextMenuGroupId: 'navigation', contextMenuOrder: 0,
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyA],
      run: (editor) => {
        const sel = editor.getSelection();
        const text = sel ? editor.getModel()!.getValueInRange(sel) : '';
        const lines = sel ? `${sel.startLineNumber}-${sel.endLineNumber}` : '';
        useStore.getState().prefillComposer(`In \`${file.path}\`${lines ? ` (lines ${lines})` : ''}:\n\n\`\`\`${languageFor(file.path)}\n${text}\n\`\`\`\n\n`);
        useDesk.getState().navigate({ view: 'chat', params: { id: useStore.getState().sessionId } });
      },
    });
    return () => { sub.dispose(); cmd.dispose(); ask.dispose(); };
  }, [file.path, file.model, file.savedVersion, onDirty, onSave]);

  return <div ref={host} className="absolute inset-0" />;
}

function AskAi({ file, root }: { file: OpenFile; root: string }): React.ReactElement {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const rel = file.path.startsWith(root) ? file.path.slice(root.length + 1) : file.path;
  const ask = (prompt: string): void => {
    setOpen(false);
    const st = useStore.getState();
    st.newSessionIn(root);
    st.prefillComposer(prompt);
    useDesk.getState().navigate({ view: 'home' });
  };
  return (
    <>
      <button ref={setAnchor} className="btn-ghost btn-sm" onClick={() => setOpen(o => !o)}><Icon name="sparkles" size={13} />Ask AI</button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} placement="bottom-end" width={260}>
        <MenuItem icon="info" label="Explain this file" onClick={() => ask(`Explain ${rel}: what it does and how it fits into the project.`)} />
        <MenuItem icon="bug" label="Find bugs in it" onClick={() => ask(`Review ${rel} for bugs, edge cases and risky code. Fix what you find.`)} />
        <MenuItem icon="flask" label="Write tests for it" onClick={() => ask(`Write thorough tests for ${rel} and run them.`)} />
        <MenuItem icon="wrench" label="Refactor it" onClick={() => ask(`Refactor ${rel} for clarity without changing behaviour. Run the tests after.`)} />
        <MenuSep />
        <MenuItem icon="edit" label="Ask something else…" onClick={() => ask(`About ${rel}: `)} />
      </Popover>
    </>
  );
}

function Tree({ root, onOpen, active, version, onChanged }: { root: string; onOpen: (p: string) => void; active: string | null; version: number; onChanged: () => void }): React.ReactElement {
  const [menu, setMenu] = useState<{ entry: Entry | null; x: number; y: number } | null>(null);
  const anchor = useRef<HTMLDivElement>(null);
  const [showHidden, setShowHidden] = useState(false);

  const create = async (dir: string, kind: 'file' | 'dir'): Promise<void> => {
    const name = window.prompt(kind === 'file' ? 'New file name' : 'New folder name');
    if (!name?.trim()) return;
    try {
      const p = await invoke<string>('fs:create', `${dir}/${name.trim()}`, kind);
      onChanged();
      if (kind === 'file') onOpen(p);
    } catch (e) { toast.error('Could not create it', (e as Error).message); }
  };

  return (
    <div className="thin-scroll relative min-h-0 flex-1 overflow-auto py-1" onContextMenu={e => { e.preventDefault(); setMenu({ entry: null, x: e.clientX, y: e.clientY }); }}>
      <div className="flex items-center gap-1 px-2 pb-1">
        <span className="flex-1 truncate text-[11.5px] font-medium uppercase tracking-wide text-aico-muted">{basename(root)}</span>
        <button className="icon-btn-sm h-6 w-6" onClick={() => void create(root, 'file')} title="New file" aria-label="New file"><Icon name="plus" size={13} /></button>
        <button className="icon-btn-sm h-6 w-6" onClick={() => void create(root, 'dir')} title="New folder" aria-label="New folder"><Icon name="folder-plus" size={13} /></button>
        <button className={cls('icon-btn-sm h-6 w-6', showHidden && 'bg-aico-hover')} onClick={() => setShowHidden(s => !s)} title="Show hidden and build folders" aria-label="Show hidden"><Icon name="eye" size={13} /></button>
        <button className="icon-btn-sm h-6 w-6" onClick={onChanged} title="Refresh" aria-label="Refresh"><Icon name="refresh" size={13} /></button>
      </div>
      <Dir path={root} depth={0} onOpen={onOpen} active={active} version={version} showHidden={showHidden}
        onMenu={(entry, x, y) => setMenu({ entry, x, y })} initiallyOpen />
      <div ref={anchor} className="fixed h-px w-px" style={{ left: menu?.x ?? 0, top: menu?.y ?? 0 }} />
      <Popover anchor={anchor.current} open={Boolean(menu)} onClose={() => setMenu(null)} placement="bottom-start" width={230}>
        {menu && (() => {
          const e = menu.entry;
          const dir = e ? (e.dir ? e.path : dirname(e.path)) : root;
          const close = (): void => setMenu(null);
          return (
            <>
              <MenuItem icon="file" label="New file" onClick={() => { close(); void create(dir, 'file'); }} />
              <MenuItem icon="folder-plus" label="New folder" onClick={() => { close(); void create(dir, 'dir'); }} />
              {e && (
                <>
                  <MenuSep />
                  <MenuItem icon="edit" label="Rename" onClick={() => {
                    close();
                    const n = window.prompt('New name', e.name);
                    if (n?.trim() && n !== e.name) void invoke('fs:rename', e.path, `${dirname(e.path)}/${n.trim()}`).then(onChanged).catch((er: Error) => toast.error('Rename failed', er.message));
                  }} />
                  <MenuItem icon="copy" label="Copy path" onClick={() => { close(); void navigator.clipboard.writeText(e.path); }} />
                  {!e.dir && /\.(?:[cm]?[jt]sx?|py|go|java|kt|cs|php|rb|rs)$/i.test(e.name) && (
                    <MenuItem icon="map" label="Show in code map" onClick={() => { close(); go('codemap', { path: root, file: relativeTo(root, e.path) }); }} />
                  )}
                  <MenuItem icon="sparkles" label="Ask AI about it" onClick={() => { close(); useStore.getState().prefillComposer(`About \`${e.path}\`: `); useDesk.getState().navigate({ view: 'chat', params: { id: useStore.getState().sessionId } }); }} />
                  <MenuItem icon="terminal" label="Open terminal here" onClick={() => { close(); useDesk.getState().setPanel({ open: true, tab: 'terminal' }); window.dispatchEvent(new CustomEvent('desk:terminal', { detail: { cwd: dir } })); }} />
                  <MenuItem icon="external" label="Reveal in file manager" onClick={() => { close(); void desktop.shell.showItemInFolder(e.path); }} />
                  <MenuSep />
                  <MenuItem icon="trash" danger label="Move to trash" onClick={() => {
                    close();
                    void desktop.dialog.confirm({ title: 'Move to trash', message: `Move ${e.name} to the trash?`, ok: 'Move to trash' })
                      .then(ok => { if (ok) void invoke('fs:trash', e.path).then(onChanged); });
                  }} />
                </>
              )}
            </>
          );
        })()}
      </Popover>
    </div>
  );
}

function Dir({ path, depth, onOpen, active, version, showHidden, onMenu, initiallyOpen }: {
  path: string; depth: number; onOpen: (p: string) => void; active: string | null; version: number; showHidden: boolean;
  onMenu: (e: Entry, x: number, y: number) => void; initiallyOpen?: boolean;
}): React.ReactElement {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (!initiallyOpen && depth === 0) return;
    invoke<Entry[]>('fs:list', path, { showHidden }).then(setEntries).catch(() => setEntries([]));
  }, [path, version, showHidden, initiallyOpen, depth]);
  if (entries === null) return <div className="px-4 py-1"><div className="skeleton h-4 w-32" /></div>;
  return (
    <div>
      {entries.map(e => (
        <div key={e.path}>
          <button
            className={cls('flex w-full items-center gap-1.5 py-[3px] pr-2 text-left text-[13px] hover:bg-aico-hover', active === e.path && 'bg-aico-accent-soft text-aico-primary')}
            style={{ paddingLeft: 8 + depth * 14 }}
            onClick={() => (e.dir ? setOpen(o => ({ ...o, [e.path]: !o[e.path] })) : onOpen(e.path))}
            onContextMenu={ev => { ev.preventDefault(); ev.stopPropagation(); onMenu(e, ev.clientX, ev.clientY); }}
            title={e.path}
          >
            {e.dir ? <Icon name={open[e.path] ? 'chevron-down' : 'chevron-right'} size={12} className="shrink-0 text-aico-muted" /> : <span className="w-3 shrink-0" />}
            <Icon name={e.dir ? (open[e.path] ? 'folder-open' : 'folder') : IMAGE.test(e.name) ? 'image' : 'file'} size={14} className={cls('shrink-0', e.dir ? 'text-aico-accent' : 'text-aico-muted')} />
            <span className="truncate">{e.name}</span>
          </button>
          {e.dir && open[e.path] && <Dir path={e.path} depth={depth + 1} onOpen={onOpen} active={active} version={version} showHidden={showHidden} onMenu={onMenu} initiallyOpen />}
        </div>
      ))}
      {entries.length === 0 && <div className="py-1 text-[12px] text-aico-muted" style={{ paddingLeft: 26 + depth * 14 }}>Empty</div>}
    </div>
  );
}

function SearchPanel({ root, onOpen }: { root: string; onOpen: (p: string, line: number) => void }): React.ReactElement {
  const [q, setQ] = useState('');
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [hits, setHits] = useState<Array<{ file: string; line: number; text: string }> | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (): Promise<void> => {
    if (!q.trim()) return;
    setBusy(true);
    try { setHits(await invoke('fs:grep', root, q, { regex, caseSensitive })); }
    catch (e) { toast.error('Search failed', (e as Error).message); }
    finally { setBusy(false); }
  };
  const grouped = useMemo(() => {
    const m = new Map<string, Array<{ line: number; text: string }>>();
    for (const h of hits ?? []) m.set(h.file, [...(m.get(h.file) ?? []), { line: h.line, text: h.text }]);
    return [...m.entries()];
  }, [hits]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-1.5 p-2">
        <input className="input h-8 py-0 text-[12.5px]" placeholder="Search in files" value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void run(); }} autoFocus />
        <div className="flex gap-1 text-[11.5px]">
          <button className={cls('chip py-0.5', caseSensitive && 'border-aico-accent text-aico-accent')} onClick={() => setCaseSensitive(c => !c)}>Aa</button>
          <button className={cls('chip py-0.5', regex && 'border-aico-accent text-aico-accent')} onClick={() => setRegex(r => !r)}>.*</button>
          <div className="flex-1" />
          {busy && <span className="spinner h-3.5 w-3.5" />}
          {hits && <span className="text-aico-muted">{hits.length} results</span>}
        </div>
      </div>
      <div className="thin-scroll min-h-0 flex-1 overflow-y-auto">
        {grouped.map(([file, list]) => (
          <div key={file} className="mb-1">
            <div className="truncate px-2 py-0.5 text-[12px] font-medium" title={file}>{basename(file)} <span className="font-normal text-aico-muted">{dirname(file).slice(root.length + 1)}</span></div>
            {list.map((h, i) => (
              <button key={i} className="flex w-full gap-2 px-3 py-0.5 text-left text-[12px] hover:bg-aico-hover" onClick={() => onOpen(file, h.line)}>
                <span className="w-8 shrink-0 text-right text-aico-muted">{h.line}</span><span className="truncate font-mono">{h.text}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function QuickOpen({ open, root, onClose, onPick }: { open: boolean; root: string; onClose: () => void; onPick: (p: string) => void }): React.ReactElement {
  const [q, setQ] = useState('');
  const [list, setList] = useState<string[]>([]);
  const [sel, setSel] = useState(0);
  useEffect(() => { if (open) { setQ(''); setSel(0); } }, [open]);
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => { void invoke<string[]>('fs:find', root, q, 60).then(l => { setList(l); setSel(0); }); }, 90);
    return () => clearTimeout(t);
  }, [q, open, root]);
  return (
    <Modal open={open} onClose={onClose} width={620} hideClose>
      <div className="border-b border-aico-border-subtle p-3">
        <input className="w-full bg-transparent text-[15px] outline-none" placeholder="Go to file" value={q} onChange={e => setQ(e.target.value)} autoFocus
          onKeyDown={e => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setSel(s => Math.min(list.length - 1, s + 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setSel(s => Math.max(0, s - 1)); }
            if (e.key === 'Enter' && list[sel]) onPick(list[sel]!);
          }} />
      </div>
      <div className="thin-scroll max-h-[50vh] overflow-y-auto p-1.5">
        {list.map((p, i) => (
          <button key={p} className={cls('flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left text-[13px]', i === sel ? 'bg-aico-hover' : 'hover:bg-aico-hover')} onMouseMove={() => setSel(i)} onClick={() => onPick(p)}>
            <Icon name="file" size={14} className="text-aico-muted" /><span className="truncate">{basename(p)}</span>
            <span className="truncate text-[12px] text-aico-muted">{dirname(p).slice(root.length + 1)}</span>
          </button>
        ))}
        {list.length === 0 && <div className="px-3 py-4 text-center text-[13px] text-aico-muted">No files match.</div>}
      </div>
    </Modal>
  );
}

/** A path inside `root`, relative and with forward slashes (the code map's spelling). */
function relativeTo(root: string, file: string): string {
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const r = norm(root);
  const f = norm(file);
  return f.toLowerCase().startsWith(`${r.toLowerCase()}/`) ? f.slice(r.length + 1) : f;
}
