/**
 * The web client's own file viewer: a project file, read-only, at a line —
 * where "Open in editor" lands when the engine cannot start an editor
 * (web/file-open, ADR 0030).
 *
 * Deliberately small: numbered lines, the target line highlighted and
 * scrolled into view, the path to copy, and "Try the editor again". It is not
 * an editor — the agent, or the person's own editor, changes files.
 *
 * Rendered once by the app shell, opened by the `aico:view-file` event.
 *
 * @module components/FileViewer
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { numbered, openFile, VIEW_FILE_EVENT, type ViewRequest } from '../file-open';
import { Icon } from './Icon';
import { Portal } from './Portal';

export function FileViewerHost(): React.ReactElement | null {
  const [req, setReq] = useState<ViewRequest | null>(null);
  useEffect(() => {
    const on = (e: Event): void => setReq((e as CustomEvent<ViewRequest>).detail);
    window.addEventListener(VIEW_FILE_EVENT, on);
    return () => window.removeEventListener(VIEW_FILE_EVENT, on);
  }, []);
  if (!req) return null;
  return <FileViewer req={req} onClose={() => setReq(null)} />;
}

export function FileViewer({ req, onClose }: { req: ViewRequest; onClose: () => void }): React.ReactElement {
  const [file, setFile] = useState<{ path: string; root: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const targetRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setFile(null); setError(null);
    api.projectFile(req.file, req.project).then(setFile).catch(err => setError(err instanceof Error ? err.message : String(err)));
  }, [req.file, req.project]);
  const view = useMemo(() => (file ? numbered(file.text, req.line) : null), [file, req.line]);
  useEffect(() => { targetRef.current?.scrollIntoView({ block: 'center' }); }, [view]);
  useEffect(() => {
    const key = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);

  const shown = file?.path ?? req.file;
  const retry = async (): Promise<void> => {
    setStatus(null);
    const said = await openFile(req.file, req.line, req.project);
    if (said) { setStatus(said); setTimeout(onClose, 900); }
  };
  const copy = (): void => { void navigator.clipboard?.writeText(file ? `${file.root}/${file.path}` : req.file).then(() => setStatus('Path copied')).catch(() => setStatus('Could not copy')); };

  return (
    <Portal>
      <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 p-4" onClick={onClose} data-file-viewer>
        <div className="flex h-[min(86vh,900px)] w-[min(1100px,96vw)] flex-col overflow-hidden rounded-xl border border-aico-border bg-aico-bg shadow-xl" onClick={e => e.stopPropagation()} role="dialog" aria-label={`File ${shown}`}>
          <header className="flex items-center gap-2 border-b border-aico-border px-3 py-2 text-[12.5px]">
            <Icon name="folder" size={14} className="text-aico-muted" />
            <span className="min-w-0 flex-1 truncate font-mono" title={shown}>{shown}{req.line ? <span className="text-aico-muted">:{req.line}</span> : null}</span>
            {status && <span className="text-aico-muted" role="status">{status}</span>}
            <button className="rounded-md px-2 py-1 text-aico-secondary hover:bg-aico-hover" onClick={copy} title="Copy the full path">Copy path</button>
            <button className="rounded-md px-2 py-1 text-aico-secondary hover:bg-aico-hover" onClick={() => void retry()} title="Ask the engine to open it in your editor again">Open in editor</button>
            <button className="rounded-md p-1 text-aico-secondary hover:bg-aico-hover" onClick={onClose} aria-label="Close"><Icon name="close" size={14} /></button>
          </header>
          {req.reason && (
            <div className="border-b border-aico-border bg-aico-surface px-3 py-1.5 text-[12px] text-aico-secondary" data-viewer-reason>
              Shown here because no editor could be opened: {req.reason} Set one in Settings → <span className="font-mono">editor.command</span> (e.g. <span className="font-mono">code -g {'{file}'}:{'{line}'}</span>).
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-auto bg-aico-bg font-mono text-[12.5px] leading-[1.55]">
            {error && <div className="p-4 text-aico-danger">{error}</div>}
            {!error && !view && <div className="p-4 text-aico-muted">Loading…</div>}
            {view && (
              <div className="min-w-max py-2">
                {view.lines.map((l, i) => (
                  <div key={i} ref={i === view.index ? targetRef : undefined} className={`flex whitespace-pre pr-6 ${i === view.index ? 'bg-aico-accent/15' : ''}`} data-line={i + 1}>
                    <span className="sticky left-0 select-none bg-inherit pl-3 pr-4 text-right text-aico-muted" style={{ minWidth: `${view.width + 3}ch` }}>{i + 1}</span>
                    <span className="text-aico-primary">{l || ' '}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </Portal>
  );
}
