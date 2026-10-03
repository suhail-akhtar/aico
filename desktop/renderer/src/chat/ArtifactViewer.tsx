/**
 * The Artifacts panel's viewer: one artifact, shown the way its type is read.
 *
 *   picture        the image, fit-to-width (tall page screenshots) or whole, or 1:1
 *   HTML           the file from its own origin, `aico://preview/<token>/` (ADR 0020,
 *                  electron/preview.ts): scripts and sibling files run, framed
 *                  `sandbox="allow-scripts"` (never same-origin), CSP with
 *                  `connect-src 'none'`; a Source tab; "Open in browser"
 *   Markdown       the transcript's renderer
 *   CSV / .xlsx    a table; a workbook's sheets as tabs (cells read by the engine)
 *   .docx          the engine's HTML of it, in a frame with scripts off
 *   code / text    the highlighted code block
 *   PDF            Chromium's own viewer, on a typed blob
 *   SVG            as an <img> from a typed blob (an <img> never runs its scripts)
 *   audio / video  the native players
 *   anything else  what it is, with Open / Show in folder / Save
 *
 * Why not `srcdoc`: a srcdoc (or blob:, or data:) frame inherits the window's
 * content-security policy, `script-src 'self' aico:`, so `allow-scripts` alone
 * ran nothing — checked in the running app. The srcdoc copy is kept only as the
 * fallback when a preview URL cannot be had, and says scripts do not run.
 *
 * Bytes come through the engine's own routes (`artifacts/file`,
 * `attachments/file`, `artifacts/preview`) via the aico:// proxy — never a
 * file:// URL — and blobs are re-typed from the extension because the engine
 * serves what it does not know as octet-stream. Text over MAX_TEXT_PREVIEW is
 * not read into the page.
 *
 * @module desktop/renderer/chat/ArtifactViewer
 */

import React, { useEffect, useMemo, useState } from 'react';
import { CodeBlock, MarkdownRenderer } from '@aico/ui';
import { wrapDocument } from '@aico/shared/ui/HtmlPreview';
import { api, type ArtifactItem, type ArtifactPreview } from '@web/api';
import { Icon } from '@/lib/icons';
import { desktop } from '@/desktop';
import { bytes as fmtBytes, cls } from '@/lib/util';
import {
  MAX_TEXT_PREVIEW, isTextual, languageFor, mimeFor, parseDelimited, typeLabel, type ArtifactEntry,
} from './artifacts-core';

/** The URL an <img> loads a file from: relative, so the aico:// proxy attaches the token. */
export function artifactUrl(sessionId: string, a: ArtifactItem): string {
  return a.source === 'attachment'
    ? `/api/attachments/file?session=${encodeURIComponent(sessionId)}&id=${encodeURIComponent(a.id)}`
    : `/api/artifacts/file?session=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(a.id)}`;
}

export function fileRef(a: ArtifactItem): { path?: string; attachment?: string } {
  return a.source === 'attachment' ? { attachment: a.id } : { path: a.id };
}

/** Colour and icon of an artifact's type, used by the list's tiles and the empty viewer. */
export function typeStyle(e: Pick<ArtifactEntry, 'kind' | 'item'>): { icon: string; tint: string } {
  const k = e.kind === 'canvas' ? e.item.kind : e.kind;
  switch (k) {
    case 'sheet': case 'csv': case 'xlsx': return { icon: 'table', tint: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' };
    case 'html': return { icon: 'globe', tint: 'bg-sky-500/10 text-sky-600 dark:text-sky-400' };
    case 'deck': return { icon: 'monitor', tint: 'bg-orange-500/10 text-orange-600 dark:text-orange-400' };
    case 'code': return { icon: 'code', tint: 'bg-violet-500/10 text-violet-600 dark:text-violet-400' };
    case 'pdf': return { icon: 'file-text', tint: 'bg-rose-500/10 text-rose-600 dark:text-rose-400' };
    case 'image': case 'svg': return { icon: 'image', tint: 'bg-amber-500/10 text-amber-600 dark:text-amber-400' };
    case 'video': return { icon: 'play', tint: 'bg-fuchsia-500/10 text-fuchsia-600 dark:text-fuchsia-400' };
    case 'audio': return { icon: 'volume', tint: 'bg-fuchsia-500/10 text-fuchsia-600 dark:text-fuchsia-400' };
    case 'document': case 'markdown': case 'docx': case 'text': return { icon: 'file-text', tint: 'bg-aico-accent-soft text-aico-accent' };
    default: return { icon: 'file', tint: 'bg-aico-hover text-aico-secondary' };
  }
}

type Loaded =
  | { state: 'loading' }
  | { state: 'error'; error: string }
  | { state: 'large' }
  | { state: 'text'; text: string }
  | { state: 'blob'; url: string }
  | { state: 'preview'; preview: ArtifactPreview };

/** Fetch what the viewer needs for this entry: text, a typed blob URL, or the engine's preview. */
function useArtifactContent(sessionId: string, entry: ArtifactEntry): Loaded {
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' });
  const { item, kind, ext } = entry;
  useEffect(() => {
    let alive = true;
    let url: string | null = null;
    setLoaded({ state: 'loading' });
    const fail = (err: unknown): void => { if (alive) setLoaded({ state: 'error', error: err instanceof Error ? err.message : String(err) }); };
    if (kind === 'xlsx' || kind === 'docx') {
      api.artifactPreview(sessionId, fileRef(item)).then(p => { if (alive) setLoaded({ state: 'preview', preview: p }); }, fail);
    } else if (isTextual(kind) && kind !== 'svg') {
      if ((item.bytes ?? 0) > MAX_TEXT_PREVIEW) setLoaded({ state: 'large' });
      else api.artifactFile(sessionId, fileRef(item)).then(b => b.text()).then(t => { if (alive) setLoaded({ state: 'text', text: t }); }, fail);
    } else if (kind === 'pdf' || kind === 'video' || kind === 'audio' || kind === 'svg') {
      api.artifactFile(sessionId, fileRef(item)).then((b) => {
        if (!alive) return;
        url = URL.createObjectURL(new Blob([b], { type: mimeFor(ext) }));
        setLoaded({ state: 'blob', url });
      }, fail);
    }
    return () => { alive = false; if (url) URL.revokeObjectURL(url); };
  }, [sessionId, item.key, item.updatedAt, kind, ext]); // eslint-disable-line react-hooks/exhaustive-deps
  return loaded;
}

export interface ViewerActions {
  openWith?: () => void;
  reveal?: () => void;
  save: () => void;
  openCanvas?: () => void;
}

export function ArtifactViewer({ sessionId, entry, actions }: {
  sessionId: string;
  entry: ArtifactEntry;
  actions: ViewerActions;
}): React.ReactElement {
  if (entry.kind === 'canvas') {
    return (
      <Placeholder entry={entry} title="A live canvas" body="Documents, sheets, presentations and code canvases open in the editor beside the chat, where you and the agent can both change them.">
        <button className="btn-accent btn-sm" onClick={actions.openCanvas}><Icon name="panel-right" size={14} />Open beside the chat</button>
      </Placeholder>
    );
  }
  if (entry.kind === 'image') return <ImageView key={entry.item.key} src={artifactUrl(sessionId, entry.item)} alt={entry.name} />;
  return <LoadedView key={entry.item.key} sessionId={sessionId} entry={entry} actions={actions} />;
}

function LoadedView({ sessionId, entry, actions }: { sessionId: string; entry: ArtifactEntry; actions: ViewerActions }): React.ReactElement {
  const loaded = useArtifactContent(sessionId, entry);
  const { kind, ext } = entry;
  if (kind === 'none') {
    return (
      <Placeholder entry={entry} title={`No preview for ${ext ? `.${ext} files` : 'this file'}`} body="Open it with the app your computer uses for this type, or save a copy.">
        <FileButtons actions={actions} />
      </Placeholder>
    );
  }
  if (loaded.state === 'loading') return <div className="grid h-full place-items-center"><span className="spinner" aria-label="Loading preview" /></div>;
  if (loaded.state === 'error') {
    return (
      <Placeholder entry={entry} title="Could not show this file" body={loaded.error}>
        <FileButtons actions={actions} />
      </Placeholder>
    );
  }
  if (loaded.state === 'large') {
    return (
      <Placeholder entry={entry} title="Too large to preview here" body={`${fmtBytes(entry.item.bytes ?? 0)} — open it in its own app instead.`}>
        <FileButtons actions={actions} />
      </Placeholder>
    );
  }
  if (loaded.state === 'blob') {
    if (kind === 'pdf') return <iframe aria-label={`PDF: ${entry.name}`} src={loaded.url} className="h-full w-full border-0 bg-aico-surface" />;
    if (kind === 'video') return <div className="grid h-full place-items-center bg-black/90 p-4"><video controls src={loaded.url} className="max-h-full max-w-full rounded-lg" /></div>;
    if (kind === 'audio') {
      return (
        <Placeholder entry={entry} title={entry.name} body={typeLabel(entry)}>
          <audio controls src={loaded.url} className="w-full max-w-[420px]" />
        </Placeholder>
      );
    }
    return <ImageView src={loaded.url} alt={entry.name} />;
  }
  if (loaded.state === 'preview') {
    const p = loaded.preview;
    if (p.type === 'table') return <SheetsView sheets={p.sheets} />;
    return <DocFrame html={p.html} truncated={p.truncated} />;
  }
  const text = loaded.text;
  if (kind === 'html') return <HtmlView html={text} sessionId={sessionId} item={entry.item} openWith={actions.openWith} />;
  if (kind === 'markdown') {
    return (
      <div className="thin-scroll h-full overflow-y-auto">
        <div className="transcript selectable mx-auto max-w-[760px] px-7 py-6"><MarkdownRenderer content={text} /></div>
      </div>
    );
  }
  if (kind === 'csv') {
    const { rows, truncated } = parseDelimited(text);
    return <SheetsView sheets={[{ name: entry.item.title, rows, truncated }]} />;
  }
  return <CodeView code={text} language={kind === 'code' ? languageFor(ext) : 'text'} label={entry.item.title} />;
}

function FileButtons({ actions }: { actions: ViewerActions }): React.ReactElement {
  return (
    <div className="flex flex-wrap justify-center gap-2">
      {actions.openWith && <button className="btn-accent btn-sm" onClick={actions.openWith}><Icon name="external" size={14} />Open</button>}
      {actions.reveal && <button className="btn-outline btn-sm" onClick={actions.reveal}><Icon name="folder-open" size={14} />Show in folder</button>}
      <button className="btn-outline btn-sm" onClick={actions.save}><Icon name="download" size={14} />Save as…</button>
    </div>
  );
}

function Placeholder({ entry, title, body, children }: { entry: ArtifactEntry; title: string; body?: string; children?: React.ReactNode }): React.ReactElement {
  const t = typeStyle(entry);
  return (
    <div className="grid h-full place-items-center p-8">
      <div className="flex max-w-[420px] flex-col items-center gap-3 text-center">
        <span className={cls('grid h-14 w-14 place-items-center rounded-2xl', t.tint)}><Icon name={t.icon} size={26} /></span>
        <div>
          <div className="text-[14.5px] font-semibold text-aico-primary">{title}</div>
          {body && <p className="selectable mt-1 break-words text-[12.5px] text-aico-muted">{body}</p>}
        </div>
        {children}
      </div>
    </div>
  );
}

type Fit = 'width' | 'fit' | 'actual';

/** A picture: tall page screenshots open fit-to-width (scroll down them), others whole; click for 1:1. */
function ImageView({ src, alt }: { src: string; alt: string }): React.ReactElement {
  const [fit, setFit] = useState<Fit | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [broken, setBroken] = useState(false);
  const mode: Fit = fit ?? (size && size.h > size.w * 1.5 ? 'width' : 'fit');
  if (broken) return <div className="grid h-full place-items-center p-6 text-[13px] text-aico-muted">The picture could not be loaded.</div>;
  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div className={cls('thin-scroll relative min-h-0 flex-1 bg-[repeating-conic-gradient(var(--aico-hover)_0%_25%,transparent_0%_50%)] [background-size:16px_16px]',
        mode === 'fit' ? 'overflow-hidden' : 'overflow-auto')}>
        <img
          src={src}
          alt={alt}
          draggable={false}
          onLoad={e => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          onError={() => setBroken(true)}
          onClick={() => setFit(mode === 'actual' ? null : 'actual')}
          className={cls('selectable',
            mode === 'width' && 'block h-auto w-full cursor-zoom-in',
            // Centred in the box and never larger than it, with room left for the size control below.
            mode === 'fit' && 'absolute inset-0 m-auto max-h-[calc(100%-72px)] max-w-[calc(100%-32px)] cursor-zoom-in object-contain shadow-sm',
            mode === 'actual' && 'block max-w-none cursor-zoom-out')}
        />
      </div>
      <div className="pointer-events-none absolute bottom-3 left-0 right-0 flex justify-center">
        <div className="segmented pointer-events-auto border border-aico-border-subtle !bg-aico-surface shadow-[var(--desk-shadow)]" role="group" aria-label="Image size">
          {([['fit', 'Fit'], ['width', 'Fit width'], ['actual', '100%']] as const).map(([m, label]) => (
            <button key={m} aria-pressed={mode === m} onClick={() => setFit(m)}>{label}</button>
          ))}
          {size && <span className="px-2 py-1 text-[11.5px] tabular-nums text-aico-muted">{size.w}×{size.h}</span>}
        </div>
      </div>
    </div>
  );
}

function HtmlView({ html, sessionId, item, openWith }: { html: string; sessionId: string; item: ArtifactItem; openWith?: () => void }): React.ReactElement {
  const [source, setSource] = useState(false);
  // The page from its own origin (aico://preview, ADR 0020) so its scripts and sibling files load;
  // a static srcdoc copy only if that cannot be had (it would inherit the window's CSP and run nothing).
  const [frame, setFrame] = useState<{ url: string } | { failed: string } | null>(null);
  useEffect(() => {
    let alive = true;
    setFrame(null);
    if (item.source !== 'file') { setFrame({ failed: 'not in the artifacts folder' }); return; }
    desktop.preview.register({ session: sessionId, path: item.id }).then(
      r => { if (alive) setFrame({ url: r.url }); },
      (err: unknown) => { if (alive) setFrame({ failed: err instanceof Error ? err.message : String(err) }); },
    );
    return () => { alive = false; };
  }, [sessionId, item.id, item.source, item.updatedAt]);
  const fallback = useMemo(() => wrapDocument(html, false), [html]);
  const scripted = /<script[\s>]/i.test(html);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-aico-border-subtle px-3 py-1.5">
        <div className="segmented" role="group" aria-label="View">
          <button aria-pressed={!source} onClick={() => setSource(false)}>Preview</button>
          <button aria-pressed={source} onClick={() => setSource(true)}>Source</button>
        </div>
        <span className="flex-1" />
        {!source && frame && 'url' in frame && (
          <span className="truncate text-[12px] text-aico-muted" title="Its own origin: no network, no access to AICO, its storage or your session.">Isolated · no network</span>
        )}
        {!source && frame && 'failed' in frame && scripted && <span className="truncate text-[12px] text-aico-muted" title={frame.failed}>Scripts don’t run in this preview</span>}
        {openWith && <button className="btn-outline btn-sm shrink-0" onClick={openWith}><Icon name="external" size={13} />Open in browser</button>}
      </div>
      {source ? <CodeView code={html} language="html" label="HTML source" />
        : !frame ? <div className="grid flex-1 place-items-center"><span className="spinner" aria-label="Loading preview" /></div>
          : 'url' in frame ? (
            // allow-scripts only: never allow-same-origin, popups, forms, downloads or top navigation.
            <iframe key={frame.url} aria-label="Web page preview" sandbox="allow-scripts" src={frame.url}
              referrerPolicy="no-referrer" className="min-h-0 w-full flex-1 border-0 bg-white" />
          ) : (
            <iframe aria-label="Web page preview" sandbox="" srcDoc={fallback}
              referrerPolicy="no-referrer" className="min-h-0 w-full flex-1 border-0 bg-white" />
          )}
    </div>
  );
}

function DocFrame({ html, truncated }: { html: string; truncated: boolean }): React.ReactElement {
  const page = `<style>body{max-width:760px;margin:28px auto!important;padding:0 28px;font:15px/1.6 system-ui,sans-serif}h1,h2,h3{line-height:1.25}img{max-width:100%}</style>${html}`;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <iframe aria-label="Document preview" sandbox="" srcDoc={wrapDocument(page, false)} referrerPolicy="no-referrer" className="min-h-0 w-full flex-1 border-0 bg-white" />
      {truncated && <div className="shrink-0 border-t border-aico-border-subtle px-4 py-1.5 text-[12px] text-aico-muted">Showing the start of the document — open it to read the rest.</div>}
    </div>
  );
}

/** Highlighting a megabyte of code stalls the window; past this it is shown plain. */
const MAX_HIGHLIGHT = 200_000;

function CodeView({ code, language, label }: { code: string; language: string; label: string }): React.ReactElement {
  return (
    <div className="thin-scroll h-full overflow-auto px-4 [&_figure]:my-3">
      <CodeBlock code={code} language={code.length > MAX_HIGHLIGHT ? '' : language} filename={label} />
    </div>
  );
}

function SheetsView({ sheets }: { sheets: Array<{ name: string; rows: string[][]; truncated: boolean }> }): React.ReactElement {
  const [at, setAt] = useState(0);
  const sheet = sheets[Math.min(at, sheets.length - 1)];
  if (!sheet || sheet.rows.length === 0) return <div className="grid h-full place-items-center text-[13px] text-aico-muted">This sheet is empty.</div>;
  const [header, ...body] = sheet.rows;
  const width = Math.max(...sheet.rows.map(r => r.length));
  const numeric = Array.from({ length: width }, (_, c) => body.length > 0 && body.every(r => !r[c] || /^-?[\d,.]+%?$|^[£$€]-?[\d,.]+$/.test(r[c]!.trim())));
  return (
    <div className="flex h-full min-h-0 flex-col">
      {sheets.length > 1 && (
        <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-aico-border-subtle px-3 py-1.5" role="tablist" aria-label="Sheets">
          {sheets.map((s, i) => (
            <button key={s.name} role="tab" aria-selected={i === at} onClick={() => setAt(i)}
              className={cls('rounded-md px-2.5 py-1 text-[12.5px]', i === at ? 'bg-aico-hover font-medium text-aico-primary' : 'text-aico-secondary hover:bg-aico-hover')}>{s.name}</button>
          ))}
        </div>
      )}
      <div className="thin-scroll selectable min-h-0 flex-1 overflow-auto">
        <table className="min-w-full border-separate border-spacing-0 text-[12.5px]">
          <thead className="sticky top-0 z-[1]">
            <tr>
              <th className="sticky left-0 z-[2] w-10 border-b border-r border-aico-border-subtle bg-aico-surface px-2 py-1.5 text-right font-normal text-aico-muted" />
              {Array.from({ length: width }, (_, c) => (
                <th key={c} className={cls('whitespace-nowrap border-b border-aico-border-subtle bg-aico-surface px-3 py-1.5 font-semibold text-aico-primary', numeric[c] ? 'text-right' : 'text-left')}>{header?.[c] ?? ''}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((row, r) => (
              <tr key={r} className="even:bg-aico-surface/60">
                <td className="sticky left-0 border-r border-aico-border-subtle bg-aico-bg px-2 py-1 text-right tabular-nums text-aico-muted">{r + 2}</td>
                {Array.from({ length: width }, (_, c) => (
                  <td key={c} className={cls('max-w-[320px] truncate border-b border-aico-border-subtle px-3 py-1 text-aico-secondary', numeric[c] && 'text-right tabular-nums')} title={row[c] && row[c]!.length > 40 ? row[c] : undefined}>{row[c] ?? ''}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="shrink-0 border-t border-aico-border-subtle px-4 py-1.5 text-[12px] text-aico-muted">
        {body.length.toLocaleString()} row{body.length === 1 ? '' : 's'} · {width} column{width === 1 ? '' : 's'}{sheet.truncated ? ' · showing the first rows only' : ''}
      </div>
    </div>
  );
}
