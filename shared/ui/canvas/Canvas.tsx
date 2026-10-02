/**
 * ```canvas — the card a reply shows for a canvas the agent wrote.
 *
 * The block carries only the id (and a title and kind to draw with before the
 * fetch lands); everything on the card — version, who edited last, the first
 * lines — is read from the live document, so a card further up the chat
 * never shows a stale copy. "Open" puts the editor beside the chat where the
 * client has room for it (the desktop), and expands it in place otherwise.
 *
 * @module shared/ui/canvas/Canvas
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Arriving } from '../rich/common';
import { getCanvasHost, onCanvasEvent, type CanvasAuthor, type CanvasDoc, type CanvasRef } from './host';
import { authorLabel, parseCanvasRef, previewLines, relativeTime } from './core';
import { CanvasEditor } from './CanvasEditor';
import { CvIcon } from './icons';
import { sheetPreview } from './sheet-model';
import './canvas.css';

export function Canvas({ source, streaming = false }: { source: string; streaming?: boolean }): React.ReactElement {
  const parsed = useMemo((): { ref?: CanvasRef; error?: string } => {
    try { return { ref: parseCanvasRef(source) }; } catch (err) { return { error: (err as Error).message }; }
  }, [source]);
  if (!parsed.ref) {
    if (streaming) return <Arriving what="Canvas" />;
    return <div className="aw aw-arriving">This canvas reference could not be read ({parsed.error}).</div>;
  }
  return <CanvasCard key={parsed.ref.id} canvas={parsed.ref} />;
}

interface Meta { version: number; author: CanvasAuthor; at: number; title: string }

function CanvasCard({ canvas }: { canvas: CanvasRef }): React.ReactElement {
  const host = getCanvasHost();
  const [doc, setDoc] = useState<CanvasDoc | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const refetch = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!host) return;
    let live = true;
    const load = (): void => {
      host.get(canvas.id, { light: true }).then((d) => {
        if (!live) return;
        setDoc(d);
        setMissing(null);
        const last = d.versions[d.versions.length - 1];
        setMeta({ version: d.version, author: last?.author ?? 'agent', at: d.updatedAt, title: d.title });
      }, (err) => { if (live) setMissing((err as Error).message); });
    };
    load();
    const off = onCanvasEvent((c) => {
      if (c.id !== canvas.id) return;
      // The line under the title follows at once; the preview is refetched
      // once the typing stops, not on every autosave.
      setMeta({ version: c.version, author: c.author, at: c.at, title: c.title || canvas.title || '' });
      window.clearTimeout(refetch.current);
      refetch.current = window.setTimeout(load, 1500);
    });
    return () => { live = false; off(); window.clearTimeout(refetch.current); };
  }, [host, canvas.id, canvas.title]);

  const kind = doc?.kind ?? canvas.kind ?? 'document';
  const language = doc?.language ?? canvas.language;
  const title = meta?.title || doc?.title || canvas.title || 'Canvas';
  const lines = useMemo(() => (!doc ? [] : kind === 'sheet' ? sheetPreview(doc.content, 3) : previewLines(doc.content, kind, 3)), [doc, kind]);

  if (expanded) {
    return (
      <div className="acv-inline-wrap">
        <CanvasEditor id={canvas.id} initial={canvas} variant="inline" onClose={() => setExpanded(false)} />
      </div>
    );
  }

  const open = (): void => {
    if (!host || missing) return;
    if (host.openPanel) host.openPanel({ ...canvas, title, kind, ...(language ? { language } : {}) });
    else setExpanded(true);
  };

  return (
    <div
      className="aw acv-card"
      role="button"
      tabIndex={0}
      aria-label={`Open canvas ${title}`}
      data-canvas-card={canvas.id}
      onClick={open}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } }}
    >
      <span className="acv-card-icon"><CvIcon name={kind === 'code' ? 'code' : kind === 'sheet' ? 'table' : 'doc'} size={20} /></span>
      <span className="acv-card-main">
        <span className="acv-card-title">
          <span>{title}</span>
          <span className="acv-badge">{kind === 'code' ? (language ?? 'code') : kind === 'sheet' ? 'sheet' : 'document'}</span>
        </span>
        <span className="acv-card-meta" style={{ display: 'block' }}>
          {!host ? 'Canvas — open it in the AICO app'
            : missing ? `Not available: ${missing}`
              : meta ? `Version ${meta.version} · edited by ${authorLabel(meta.author)} · ${relativeTime(meta.at)}`
                : 'Loading…'}
        </span>
        {lines.length > 0 && (
          <span className={`acv-card-preview${kind === 'code' ? ' is-code' : ''}`}>{lines.join(kind === 'code' ? '\n' : ' ')}</span>
        )}
      </span>
      {host && !missing && (
        <span className="aw-btn acv-card-open" aria-hidden="true">
          <CvIcon name={host.openPanel ? 'open' : 'expand'} size={13} /> Open
        </span>
      )}
    </div>
  );
}
