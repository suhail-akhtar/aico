/**
 * ```files — the files an answer produced, as cards you can act on.
 *
 * In the desktop app the cards open the file and show it in its folder,
 * through the shell. In the browser portal a card opens the file in the
 * person's editor when the engine can start one, or in the portal's own
 * viewer (files of registered projects only — server/editor). Everywhere the
 * path can be copied.
 *
 * @module shared/ui/rich/Files
 */

import React, { useState } from 'react';
import { Arriving, copyText, desktopBridge, fileOpener, Icon, useParsed } from './common';
import { formatBytes, parseFiles, type FileItem, type FileKind, type FilesSpec } from './specs';

export function Files({ source, streaming = false }: { source: string; streaming?: boolean }): React.ReactElement {
  const { spec, waiting } = useParsed(source, streaming, parseFiles);
  if (waiting || !spec) return <Arriving what="Files" />;
  return <FilesView spec={spec} />;
}

const KIND_LABEL: Record<FileKind, string> = {
  pdf: 'PDF', sheet: 'Spreadsheet', doc: 'Document', slides: 'Presentation', csv: 'CSV', markdown: 'Markdown',
  image: 'Image', code: 'Code', archive: 'Archive', text: 'Text', audio: 'Audio', video: 'Video', file: 'File',
};

function FilesView({ spec }: { spec: FilesSpec }): React.ReactElement {
  return (
    <div className="aw aw-files">
      {spec.title && <div className="aw-heading">{spec.title}</div>}
      <div className="aw-files-grid" role="list">
        {spec.files.map(f => <FileCard key={f.id} file={f} />)}
      </div>
    </div>
  );
}

function FileCard({ file }: { file: FileItem }): React.ReactElement {
  const bridge = desktopBridge();
  const opener = bridge ? undefined : fileOpener();
  const [status, setStatus] = useState<string | null>(null);
  const flash = (s: string): void => { setStatus(s); setTimeout(() => setStatus(null), 1800); };
  const open = async (): Promise<void> => {
    try {
      const err = await bridge!.invoke('shell:openPath', file.path);
      if (typeof err === 'string' && err) flash(err);
    } catch (e) { flash((e as Error).message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')); }
  };
  const reveal = async (): Promise<void> => {
    try { await bridge!.invoke('shell:showItemInFolder', file.path); } catch (e) { flash((e as Error).message); }
  };
  const size = formatBytes(file.size);
  return (
    <div className="aw-file" role="listitem">
      <FileBadge kind={file.kind} ext={file.ext} />
      <div className="aw-file-text">
        <div className="aw-file-name" title={file.name}>{file.name}</div>
        <div className="aw-file-meta">
          <span>{KIND_LABEL[file.kind]}{file.ext && file.kind !== 'file' ? '' : file.ext ? ` · .${file.ext}` : ''}</span>
          {size && <><span className="aw-dot">·</span><span>{size}</span></>}
        </div>
        <div className="aw-file-path" title={file.path}>{status ?? file.path}</div>
      </div>
      <div className="aw-file-actions">
        {bridge ? (
          <>
            <button type="button" className="aw-btn" onClick={() => { void open(); }} title="Open with the default app"><Icon name="open" size={12} /> Open</button>
            <button type="button" className="aw-icon-btn" onClick={() => { void reveal(); }} title="Show in folder" aria-label="Show in folder"><Icon name="folder" size={14} /></button>
          </>
        ) : opener && (file.kind === 'code' || file.kind === 'text' || file.kind === 'markdown' || file.kind === 'csv') ? (
          <button type="button" className="aw-btn" onClick={() => opener(file.path)} title="Open in your editor (or the viewer when no editor is available)"><Icon name="open" size={12} /> Open</button>
        ) : null}
        <button
          type="button"
          className="aw-icon-btn"
          onClick={() => { void copyText(file.path).then(ok => flash(ok ? 'Path copied' : 'Could not copy')); }}
          title="Copy the path"
          aria-label="Copy the path"
        >
          <Icon name={status === 'Path copied' ? 'check' : 'copy'} size={14} />
        </button>
      </div>
    </div>
  );
}

const BADGE: Record<FileKind, string> = {
  pdf: '#e5484d', sheet: '#1f9d55', doc: '#2f6fed', slides: '#e5731a', csv: '#139e8c', markdown: '#6b7280',
  image: '#8b5cf6', code: '#475569', archive: '#b7791f', text: '#64748b', audio: '#db2777', video: '#7c3aed', file: '#6b7280',
};

function FileBadge({ kind, ext }: { kind: FileKind; ext: string }): React.ReactElement {
  const label = (ext || kind).slice(0, 4).toUpperCase();
  return (
    <span className="aw-file-badge" style={{ ['--aw-file' as string]: BADGE[kind] }} aria-hidden="true">
      <svg viewBox="0 0 32 40" width="32" height="40">
        <path d="M4 2h17l9 9v25a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z" className="aw-file-sheet" />
        <path d="M21 2v7a2 2 0 0 0 2 2h7" className="aw-file-fold" />
      </svg>
      <span className="aw-file-ext">{label}</span>
    </span>
  );
}
