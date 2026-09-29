/**
 * Editing bookmarks: the star in the toolbar and its "Bookmark added / Edit
 * bookmark" bubble (name, folder, Remove, Done — like Chrome's), the folder
 * picker it shares with the dialogs, and the dialogs themselves (edit, add
 * page, new folder, rename, bookmark all tabs, import).
 *
 * The bubble keeps what you typed when it closes any way but Remove, as a
 * browser's does; the star then puts your next bookmark in the folder you
 * chose last.
 *
 * @module desktop/renderer/browser/BookmarkEditor
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@/lib/icons';
import { cls } from '@/lib/util';
import { toast } from '@/state/desk';
import { Popover } from '@/shell/Popover';
import { Modal } from '@/shell/Modal';
import { BAR_ID, OTHER_ID, getNode, locate } from '@desk/bookmark-tree';
import type { BookmarkImportResult, BookmarkImportSource, BookmarkNode } from '@desk/browser-types';
import { call, useAvailable } from './ipc';
import { useBrowser } from './store';
import { isBlankUrl, parseOmnibox } from './urls';
import { bookmarkTab, change, deleteNodes, useBookmarks, type BookmarkDialog } from './bookmarks';
import { openImportWizard } from './ImportWizard';
import type { TabState } from './types';

// ── The star and its bubble ──

export function BookmarkStar({ tab }: { tab: TabState | undefined }): React.ReactElement {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const star = useBookmarks(s => s.star);
  const bookmarked = useBrowser(s => Boolean(tab && s.bookmarks.some(b => b.url === tab.url)));
  const canMark = useAvailable('browser:bookmarks:create');
  const blank = !tab || isBlankUrl(tab.url);
  const commit = useRef<(() => void) | null>(null);
  const close = useCallback(() => {
    commit.current?.();
    commit.current = null;
    useBookmarks.setState({ star: null });
  }, []);
  return (
    <>
      <button ref={setAnchor} data-bm-star className={cls('icon-btn-sm', bookmarked && 'text-aico-warning hover:text-aico-warning')} disabled={blank || !canMark}
        onClick={() => { if (star) close(); else void bookmarkTab(tab); }} aria-haspopup="dialog" aria-expanded={Boolean(star)}
        title={canMark ? (bookmarked ? 'Edit bookmark for this tab (Ctrl+D)' : 'Bookmark this tab (Ctrl+D)') : 'Bookmarks are not available in this version'}>
        <Icon name="star" size={16} style={bookmarked ? { fill: 'currentColor' } : undefined} />
      </button>
      <Popover anchor={anchor} open={Boolean(star && anchor)} onClose={close} placement="bottom-end" width={340}>
        {star && <StarBubble key={star.id} id={star.id} added={star.added} commit={commit} close={close} />}
      </Popover>
    </>
  );
}

function StarBubble({ id, added, commit, close }: { id: string; added: boolean; commit: React.MutableRefObject<(() => void) | null>; close: () => void }): React.ReactElement | null {
  const tree = useBookmarks(s => s.tree);
  const hit = locate(tree, id);
  const [title, setTitle] = useState(hit?.node.title ?? '');
  const [folder, setFolder] = useState(hit?.parent?.id ?? BAR_ID);
  useEffect(() => { if (!hit) { commit.current = null; close(); } }, [hit, commit, close]);
  if (!hit) return null;
  commit.current = () => {
    if (title.trim() && title !== hit.node.title) void change('browser:bookmarks:update', id, { title });
    if (folder !== hit.parent?.id) void change('browser:bookmarks:move', [id], folder);
    useBookmarks.setState({ lastFolder: folder });
  };
  return (
    <div className="p-3" onKeyDown={e => { if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT' && !(e.target as HTMLElement).dataset.rename) { e.preventDefault(); close(); } }}>
      <div className="mb-3 flex items-center gap-2 text-[15px] font-semibold">
        <Icon name="star" size={16} className="text-aico-warning" style={{ fill: 'currentColor' }} />
        {added ? 'Bookmark added' : 'Edit bookmark'}
      </div>
      <label className="mb-1 block text-[12px] font-medium text-aico-muted" htmlFor="bm-star-name">Name</label>
      <input id="bm-star-name" className="input mb-3 w-full" value={title} autoFocus onChange={e => setTitle(e.target.value)} onFocus={e => e.currentTarget.select()} />
      <div className="mb-1 text-[12px] font-medium text-aico-muted">Folder</div>
      <FolderPicker value={folder} onChange={setFolder} height={168} />
      <div className="mt-3 flex items-center gap-2">
        <button className="btn-outline btn-sm" onClick={() => { commit.current = null; close(); void deleteNodes([id]); }}>Remove</button>
        <div className="flex-1" />
        <button className="btn-primary btn-sm" onClick={close}>Done</button>
      </div>
    </div>
  );
}

// ── Choosing a folder ──

/** The folder tree, one folder selected; "New folder" makes one inside the selected folder and names it in place. */
export function FolderPicker({ value, onChange, height = 200 }: { value: string; onChange: (id: string) => void; height?: number }): React.ReactElement {
  const tree = useBookmarks(s => s.tree);
  const [open, setOpen] = useState<Set<string>>(() => new Set([BAR_ID, OTHER_ID, ...(locate(tree, value)?.ancestors.map(a => a.id) ?? [])]));
  const [renaming, setRenaming] = useState<{ id: string; text: string } | null>(null);
  const list = useRef<HTMLDivElement>(null);

  const rows = useMemo(() => {
    const out: Array<{ node: BookmarkNode; depth: number; subs: boolean }> = [];
    const visit = (n: BookmarkNode, depth: number): void => {
      const subs = (n.children ?? []).some(c => c.children);
      out.push({ node: n, depth, subs });
      if (open.has(n.id)) for (const c of n.children ?? []) if (c.children) visit(c, depth + 1);
    };
    for (const r of tree.roots) visit(r, 0);
    return out;
  }, [tree, open]);

  useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }, [value]);

  const newFolder = async (): Promise<void> => {
    const node = await change<BookmarkNode>('browser:bookmarks:create', { parentId: value, title: 'New folder' });
    if (!node?.id) return;
    setOpen(s => new Set([...s, value]));
    onChange(node.id);
    setRenaming({ id: node.id, text: node.title });
  };
  const finishRename = (): void => {
    if (renaming && renaming.text.trim()) void change('browser:bookmarks:update', renaming.id, { title: renaming.text });
    setRenaming(null);
  };

  return (
    <div>
      <div ref={list} role="tree" className="overflow-y-auto rounded-xl border border-aico-border-subtle p-1 thin-scroll" style={{ height }}>
        {rows.map(({ node, depth, subs }) => (
          <div key={node.id} role="treeitem" aria-selected={node.id === value} aria-expanded={subs ? open.has(node.id) : undefined}
            className={cls('flex h-7 cursor-default items-center gap-1.5 rounded-lg pr-2 text-[13px]', node.id === value ? 'bg-aico-accent-soft text-aico-accent' : 'hover:bg-aico-hover')}
            style={{ paddingLeft: 4 + depth * 14 }} onClick={() => onChange(node.id)}>
            <button type="button" tabIndex={-1} className={cls('flex h-4 w-4 items-center justify-center text-aico-muted', !subs && 'invisible')}
              onClick={e => { e.stopPropagation(); setOpen(s => { const n = new Set(s); if (n.has(node.id)) n.delete(node.id); else n.add(node.id); return n; }); }}>
              <Icon name={open.has(node.id) ? 'chevron-down' : 'chevron-right'} size={12} />
            </button>
            <Icon name={node.id === value ? 'folder-open' : 'folder'} size={15} className="shrink-0" />
            {renaming?.id === node.id
              ? <input autoFocus data-rename="1" className="input h-6 min-w-0 flex-1 px-1.5 py-0 text-[12.5px]" value={renaming.text}
                  onFocus={e => e.currentTarget.select()} onChange={e => setRenaming({ id: node.id, text: e.target.value })}
                  onBlur={finishRename} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); finishRename(); } }} />
              : <span className="min-w-0 flex-1 truncate">{node.title}</span>}
          </div>
        ))}
      </div>
      <button type="button" className="btn-ghost btn-sm mt-1.5" onClick={() => void newFolder()}><Icon name="folder-plus" size={14} />New folder</button>
    </div>
  );
}

// ── Dialogs ──

export function BookmarkDialogs(): React.ReactElement | null {
  const d = useBookmarks(s => s.dialog);
  const close = useCallback(() => useBookmarks.setState({ dialog: null }), []);
  if (!d) return null;
  if (d.kind === 'import') return <ImportDialog close={close} />;
  return <EditDialog key={JSON.stringify(d)} d={d} close={close} />;
}

function toUrl(input: string): string | null {
  const t = input.trim();
  if (!t) return null;
  if (/^(https?|file|ftp|about|chrome|data|javascript):/i.test(t)) return t;
  const p = parseOmnibox(t);
  return p?.kind === 'url' ? p.url : null;
}

function EditDialog({ d, close }: { d: Exclude<BookmarkDialog, { kind: 'import' }>; close: () => void }): React.ReactElement {
  const tree = useBookmarks(s => s.tree);
  const tabs = useBrowser(s => s.state.tabs);
  const node = 'id' in d ? getNode(tree, d.id) : undefined;
  const isPage = d.kind === 'add-page' || (d.kind === 'edit' && Boolean(node?.url));
  const pickFolder = d.kind !== 'rename' && !(d.kind === 'edit' && node?.children);
  const startParent = 'parentId' in d ? d.parentId : ('id' in d ? locate(tree, d.id)?.parent?.id : undefined) ?? BAR_ID;
  const pages = tabs.filter(t => !isBlankUrl(t.url));
  const [title, setTitle] = useState(node?.title ?? (d.kind === 'add-page' ? d.title ?? '' : d.kind === 'all-tabs' ? 'Tabs' : d.kind === 'add-folder' ? 'New folder' : ''));
  const [url, setUrl] = useState(node?.url ?? (d.kind === 'add-page' ? d.url ?? '' : ''));
  const [folder, setFolder] = useState(startParent);
  const [error, setError] = useState('');
  const heading = d.kind === 'add-page' ? 'Add bookmark' : d.kind === 'add-folder' ? 'New folder' : d.kind === 'all-tabs' ? 'Bookmark all tabs'
    : isPage ? 'Edit bookmark' : 'Rename folder';

  const save = async (): Promise<void> => {
    const fixed = isPage ? toUrl(url) : null;
    if (isPage && !fixed) { setError('Enter a web address, like example.com'); return; }
    const index = folder === startParent && 'index' in d ? d.index : undefined;
    if (d.kind === 'add-page') await change('browser:bookmarks:create', { parentId: folder, index, title: title || fixed, url: fixed });
    else if (d.kind === 'add-folder') {
      const made = await change<BookmarkNode>('browser:bookmarks:create', { parentId: folder, index, title: title || 'New folder' });
      if (made?.id) d.then?.(made.id);
    } else if (d.kind === 'all-tabs') {
      await change('browser:bookmarks:addTabs', { parentId: folder, title: title || 'Tabs', items: pages.map(t => ({ url: t.url, title: t.title, favicon: t.favicon })) });
      toast.success(`Bookmarked ${pages.length} tab${pages.length === 1 ? '' : 's'}`, title);
    } else if (node) {
      await change('browser:bookmarks:update', node.id, { title, ...(isPage ? { url: fixed } : {}) });
      if (pickFolder && folder !== startParent) await change('browser:bookmarks:move', [node.id], folder);
    }
    close();
  };

  return (
    <Modal open onClose={close} title={heading} width={pickFolder ? 460 : 400}>
      <form className="px-5 pb-4 pt-2" onSubmit={e => { e.preventDefault(); void save(); }}>
        {d.kind === 'all-tabs' && <p className="mb-3 text-[12.5px] text-aico-muted">{pages.length} open tab{pages.length === 1 ? '' : 's'} will be bookmarked into a new folder.</p>}
        <label className="mb-1 block text-[12px] font-medium text-aico-muted" htmlFor="bm-name">{isPage ? 'Name' : 'Folder name'}</label>
        <input id="bm-name" className="input mb-3 w-full" value={title} autoFocus onFocus={e => e.currentTarget.select()} onChange={e => setTitle(e.target.value)} />
        {isPage && (
          <>
            <label className="mb-1 block text-[12px] font-medium text-aico-muted" htmlFor="bm-url">URL</label>
            <input id="bm-url" className={cls('input mb-1 w-full font-mono text-[12.5px]', error && 'border-aico-danger')} value={url} onChange={e => { setUrl(e.target.value); setError(''); }} />
            <div className="mb-3 h-4 text-[11.5px] text-aico-danger">{error}</div>
          </>
        )}
        {pickFolder && (
          <>
            <div className="mb-1 text-[12px] font-medium text-aico-muted">{d.kind === 'add-folder' || d.kind === 'all-tabs' ? 'Put it in' : 'Folder'}</div>
            <FolderPicker value={folder} onChange={setFolder} height={200} />
          </>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="btn-outline" onClick={close}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={d.kind === 'all-tabs' && pages.length === 0}>Save</button>
        </div>
      </form>
    </Modal>
  );
}

function ImportDialog({ close }: { close: () => void }): React.ReactElement {
  const [sources, setSources] = useState<BookmarkImportSource[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => { void call<BookmarkImportSource[]>('browser:bookmarks:importSources').then(s => setSources(s ?? [])).catch(() => setSources([])); }, []);
  const run = async (src: BookmarkImportSource): Promise<void> => {
    setBusy(src.id);
    const r = await change<BookmarkImportResult | null>('browser:bookmarks:import', src.id);
    setBusy(null);
    if (!r) return;
    toast.success(`Imported ${r.count} bookmark${r.count === 1 ? '' : 's'}`, `Into “${r.title}” on the bookmarks bar${r.skipped ? ` — ${r.skipped} skipped (bookmarklets and browser-internal links)` : ''}.`);
    close();
  };
  const found = sources?.filter(s => s.kind === 'chromium') ?? [];
  const files = sources?.filter(s => s.kind === 'html') ?? [];
  const row = (s: BookmarkImportSource): React.ReactElement => (
    <div key={s.id} className="flex items-center gap-3 rounded-xl px-3 py-2 hover:bg-aico-hover">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-aico-hover text-aico-secondary"><Icon name={s.kind === 'html' ? 'file' : 'globe'} size={16} /></span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px]">{s.browser}</span>
        <span className="block truncate text-[12px] text-aico-muted">
          {s.kind === 'html' ? (s.profile ? `From an ${s.profile}` : 'Exported from any browser') : `${s.profile}${s.count !== undefined ? ` · ${s.count} bookmark${s.count === 1 ? '' : 's'}` : ''}`}
        </span>
      </span>
      <button className="btn-outline btn-sm" disabled={busy !== null} onClick={() => void run(s)}>
        {busy === s.id && <span className="spinner h-3.5 w-3.5" />}{s.kind === 'html' ? 'Choose file…' : 'Import'}
      </button>
    </div>
  );
  return (
    <Modal open onClose={close} title="Import bookmarks" width={500}>
      <div className="px-5 pb-5 pt-1">
        <p className="mb-3 text-[12.5px] text-aico-muted">Bookmarks are copied into a new “Imported from …” folder on the bookmarks bar. The other browser is only read, never changed.</p>
        {!sources && <div className="flex items-center gap-2 py-6 text-[13px] text-aico-muted"><span className="spinner h-4 w-4" />Looking for browsers…</div>}
        {sources && (
          <>
            <div className="mb-1 text-[12px] font-medium text-aico-muted">Browsers on this computer</div>
            {found.length ? found.map(row) : <div className="px-3 py-2 text-[12.5px] text-aico-muted">No Chrome, Edge or Brave profile with bookmarks was found.</div>}
            <div className="mb-1 mt-3 text-[12px] font-medium text-aico-muted">From a file</div>
            {files.map(row)}
            <p className="mt-2 px-3 text-[11.5px] text-aico-muted">In Firefox: Bookmarks → Manage bookmarks → Import and Backup → Export Bookmarks to HTML.</p>
            <button className="mt-3 px-3 text-[12px] text-aico-accent hover:underline" onClick={() => { close(); openImportWizard({ parts: ['bookmarks'] }); }}>
              Firefox, Vivaldi, Opera — or history, addresses and passwords too: Import browser data…
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}
