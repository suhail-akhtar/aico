/**
 * AICO Docs' two dialogs: **Export** (format, page, header/footer, cover,
 * contents, watermark, font — remembered per document) and **New document**
 * (a template picker).
 *
 * The export dialog previews with the engine's own HTML export of the same
 * settings in a sandboxed frame — the PDF is that HTML printed, so what the
 * preview shows is what the PDF gets, without a second renderer here that
 * could drift from the engine's. Settings are stored with the document when
 * the engine has the route for it (`docSettings`, see the contract doc), and
 * in this browser's storage until then, so a report's cover page does not
 * have to be typed again for every export.
 *
 * @module shared/ui/canvas/DocDialogs
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { DocSettings, ExportFormat } from './host';
import { EXPORT_TYPES, imageDataUrl, pickImage } from './export';
import { DOC_TEMPLATES, longDate } from './templates';
import { CvIcon } from './icons';

const SETTINGS_KEY = (id: string): string => `aico.docs.settings.${id}`;

export function storedSettings(id: string): DocSettings | null {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY(id));
    return raw ? JSON.parse(raw) as DocSettings : null;
  } catch { return null; }
}

export function rememberSettings(id: string, s: DocSettings): void {
  try { localStorage.setItem(SETTINGS_KEY(id), JSON.stringify(s)); } catch { /* not remembered: the dialog still exports */ }
}

export function defaultSettings(title: string): DocSettings {
  return {
    pageSize: 'A4', orientation: 'portrait', margins: 'normal', header: '', footer: '', pageNumbers: true,
    cover: { enabled: false, title, subtitle: '', author: '', date: longDate(), logo: '' }, toc: false, watermark: '', font: 'sans',
  };
}

function Modal({ label, onClose, children, wide = false }: { label: string; onClose: () => void; children: React.ReactNode; wide?: boolean }): React.ReactElement {
  useEffect(() => {
    const esc = (e: KeyboardEvent): void => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', esc, true);
    return () => window.removeEventListener('keydown', esc, true);
  }, [onClose]);
  return (
    <div className="adoc-modal-back" data-adoc-keep-focus onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`adoc-modal${wide ? ' is-wide' : ''}`} role="dialog" aria-modal="true" aria-label={label}>
        {children}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return <label className="adoc-field"><span>{label}</span>{children}</label>;
}

/** The engine stores margins as millimetres; the dialog offers its three presets. */
function marginPreset(m: unknown): 'narrow' | 'normal' | 'wide' {
  if (m === 'narrow' || m === 'normal' || m === 'wide') return m;
  const top = (m as { top?: number } | null)?.top;
  return typeof top !== 'number' ? 'normal' : top < 19 ? 'narrow' : top > 32 ? 'wide' : 'normal';
}

export function ExportDialog({ title, coverTitle, initial, preview, onExport, onSave, onClose }: {
  title: string;
  /** What a new cover page is titled: the document's own title. */
  coverTitle?: string;
  initial: DocSettings;
  /** The engine's HTML export with these settings; null when the engine cannot preview. */
  preview?: (s: DocSettings) => Promise<string | null>;
  onExport: (format: ExportFormat, s: DocSettings) => Promise<void>;
  onSave: (s: DocSettings) => void;
  onClose: () => void;
}): React.ReactElement {
  const [s, setS] = useState<DocSettings>(() => {
    const base = defaultSettings(coverTitle ?? title);
    return { ...base, ...initial, margins: marginPreset(initial.margins), cover: { ...base.cover!, ...(initial.cover ?? {}) } };
  });
  const [format, setFormat] = useState<ExportFormat>('pdf');
  const [busy, setBusy] = useState(false);
  const [html, setHtml] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const set = (p: Partial<DocSettings>): void => setS(x => ({ ...x, ...p }));
  const setCover = (p: Partial<NonNullable<DocSettings['cover']>>): void => setS(x => ({ ...x, cover: { ...x.cover!, ...p } }));
  const key = useMemo(() => JSON.stringify(s), [s]);

  useEffect(() => {
    if (!preview) return;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      preview(s).then(h => { setHtml(h); setPreviewError(null); }, err => setPreviewError(err instanceof Error ? err.message : String(err)));
    }, 450);
    return () => window.clearTimeout(timer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, preview]);

  const paged = format === 'pdf' || format === 'docx';
  const run = async (): Promise<void> => {
    setBusy(true);
    onSave(s);
    try { await onExport(format, s); onClose(); } finally { setBusy(false); }
  };
  const logo = async (): Promise<void> => {
    const f = await pickImage();
    if (f) setCover({ logo: await imageDataUrl(f) });
  };

  return (
    <Modal label="Export" onClose={onClose} wide={Boolean(preview)}>
      <div className="adoc-modal-head"><CvIcon name="share" size={15} /> Export “{title}”<span className="aw-grow" />
        <button type="button" className="aw-icon-btn" onClick={onClose} aria-label="Close"><CvIcon name="close" size={14} /></button>
      </div>
      <div className="adoc-export">
        <div className="adoc-export-form">
          <Field label="Format">
            <div className="acv-seg adoc-seg-text" role="group" aria-label="Format">
              {(['pdf', 'docx', 'html', 'md'] as ExportFormat[]).map(f => (
                <button key={f} type="button" className={format === f ? 'is-on' : ''} aria-pressed={format === f} onClick={() => setFormat(f)}>
                  {f === 'docx' ? 'Word' : f === 'md' ? 'Markdown' : f.toUpperCase()}
                </button>
              ))}
            </div>
          </Field>
          <fieldset disabled={!paged} className="adoc-fieldset">
            <legend>Page</legend>
            <div className="adoc-row">
              <Field label="Size">
                <select value={s.pageSize} onChange={e => set({ pageSize: e.target.value as DocSettings['pageSize'] })}>
                  <option value="A4">A4</option><option value="Letter">Letter</option>
                </select>
              </Field>
              <Field label="Orientation">
                <select value={s.orientation} onChange={e => set({ orientation: e.target.value as DocSettings['orientation'] })}>
                  <option value="portrait">Portrait</option><option value="landscape">Landscape</option>
                </select>
              </Field>
              <Field label="Margins">
                <select value={marginPreset(s.margins)} onChange={e => set({ margins: e.target.value as DocSettings['margins'] })}>
                  <option value="narrow">Narrow</option><option value="normal">Normal</option><option value="wide">Wide</option>
                </select>
              </Field>
            </div>
            <div className="adoc-row">
              <Field label="Header"><input value={s.header ?? ''} placeholder="e.g. {title}" onChange={e => set({ header: e.target.value })} /></Field>
              <Field label="Footer"><input value={s.footer ?? ''} placeholder="e.g. Company — {date}" onChange={e => set({ footer: e.target.value })} /></Field>
            </div>
            <label className="adoc-ask-check"><input type="checkbox" checked={Boolean(s.pageNumbers)} onChange={e => set({ pageNumbers: e.target.checked })} /> Page numbers</label>
          </fieldset>
          <fieldset disabled={format === 'md'} className="adoc-fieldset">
            <legend>Content</legend>
            <label className="adoc-ask-check"><input type="checkbox" checked={Boolean(s.cover?.enabled)} onChange={e => setCover({ enabled: e.target.checked })} /> Cover page</label>
            {s.cover?.enabled && (
              <div className="adoc-cover-fields">
                <Field label="Title"><input value={s.cover.title ?? ''} onChange={e => setCover({ title: e.target.value })} /></Field>
                <Field label="Subtitle"><input value={s.cover.subtitle ?? ''} onChange={e => setCover({ subtitle: e.target.value })} /></Field>
                <div className="adoc-row">
                  <Field label="Author"><input value={s.cover.author ?? ''} onChange={e => setCover({ author: e.target.value })} /></Field>
                  <Field label="Date"><input value={s.cover.date ?? ''} onChange={e => setCover({ date: e.target.value })} /></Field>
                </div>
                <div className="adoc-row adoc-logo-row">
                  {s.cover.logo ? <img src={s.cover.logo} alt="Logo" className="adoc-logo-thumb" /> : <span className="aw-muted">No logo</span>}
                  <button type="button" className="aw-btn adoc-mini" onClick={() => { void logo(); }}><CvIcon name="image" size={12} /> {s.cover.logo ? 'Change logo' : 'Add logo'}</button>
                  {s.cover.logo && <button type="button" className="aw-btn adoc-mini" onClick={() => setCover({ logo: '' })}>Remove</button>}
                </div>
              </div>
            )}
            <label className="adoc-ask-check"><input type="checkbox" checked={Boolean(s.toc)} onChange={e => set({ toc: e.target.checked })} /> Table of contents</label>
            <div className="adoc-row">
              <Field label="Watermark"><input value={s.watermark ?? ''} placeholder="e.g. CONFIDENTIAL" onChange={e => set({ watermark: e.target.value })} /></Field>
              <Field label="Font">
                <select value={s.font} onChange={e => set({ font: e.target.value as DocSettings['font'] })}>
                  <option value="sans">Modern (sans)</option><option value="serif">Classic (serif)</option>
                </select>
              </Field>
            </div>
          </fieldset>
        </div>
        {preview && (
          <div className="adoc-export-preview" aria-label="Preview">
            {html ? <iframe title="Export preview" sandbox="" srcDoc={html} /> : <div className="acv-empty">{previewError ? `No preview: ${previewError}` : 'Preparing preview…'}</div>}
          </div>
        )}
      </div>
      <div className="adoc-modal-foot">
        <span className="aw-muted">Settings are saved with this document.</span>
        <span className="aw-grow" />
        <button type="button" className="aw-btn" onClick={onClose}>Cancel</button>
        <button type="button" className="aw-btn is-primary" disabled={busy} onClick={() => { void run(); }}>
          {busy ? 'Exporting…' : `Export ${EXPORT_TYPES[format].label}`}
        </button>
      </div>
    </Modal>
  );
}

export function TemplatePicker({ onCreate, onClose, canCreate }: {
  onCreate: (input: { template: string; title: string; draft: boolean }) => Promise<void>;
  onClose: () => void;
  /** False when the engine has no create route — the agent is asked to create it instead. */
  canCreate: boolean;
}): React.ReactElement {
  const [template, setTemplate] = useState('report');
  const [title, setTitle] = useState('');
  const [draft, setDraft] = useState(false);
  const [busy, setBusy] = useState(false);
  const chosen = DOC_TEMPLATES.find(t => t.id === template)!;
  const create = async (): Promise<void> => {
    setBusy(true);
    try { await onCreate({ template, title: title.trim() || chosen.label, draft }); onClose(); } finally { setBusy(false); }
  };
  return (
    <Modal label="New document" onClose={onClose}>
      <div className="adoc-modal-head"><CvIcon name="doc" size={15} /> New document<span className="aw-grow" />
        <button type="button" className="aw-icon-btn" onClick={onClose} aria-label="Close"><CvIcon name="close" size={14} /></button>
      </div>
      <div className="adoc-templates" role="listbox" aria-label="Templates">
        {DOC_TEMPLATES.map(t => (
          <button key={t.id} type="button" role="option" aria-selected={t.id === template} className={`adoc-template${t.id === template ? ' is-on' : ''}`}
            onClick={() => setTemplate(t.id)} onDoubleClick={() => { setTemplate(t.id); }}>
            <span className="adoc-template-name">{t.label}</span>
            <span className="adoc-template-desc">{t.description}</span>
          </button>
        ))}
      </div>
      <div className="adoc-new-fields">
        <Field label="Title"><input autoFocus value={title} placeholder={chosen.label} onChange={e => setTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void create(); }} /></Field>
        {template !== 'blank' && (
          <label className="adoc-ask-check"><input type="checkbox" checked={draft} onChange={e => setDraft(e.target.checked)} /> Ask AICO to draft every section</label>
        )}
      </div>
      <div className="adoc-modal-foot">
        {!canCreate && <span className="aw-muted">This engine creates documents through AICO in the chat.</span>}
        <span className="aw-grow" />
        <button type="button" className="aw-btn" onClick={onClose}>Cancel</button>
        <button type="button" className="aw-btn is-primary" disabled={busy} onClick={() => { void create(); }}>{busy ? 'Creating…' : 'Create'}</button>
      </div>
    </Modal>
  );
}
