/**
 * The deck editor's visual tools (ADR 0025): the infographic gallery, the
 * infographic item editor, the picture picker (licensed search, project
 * files, upload, generated art, ask AICO to generate), the picture grid
 * editor, the design brief and brand palette panel, and "Make this slide
 * visual".
 *
 * ## Why a module of its own
 *
 * `DeckEditor.tsx` owns saving, replay and layout of the editor; these are
 * self-contained panels that only read the slide and hand back field
 * changes (`patch`) or deck settings (`meta`) — the same operations the
 * editor already replays over the agent's writes. Keeping them here keeps
 * the editor's diff to a few insertion points.
 *
 * Pictures the person picks from a search are placed by the engine (it
 * downloads only a candidate the search returned, with its credit); the
 * picker's previews are served by the engine too (`/api/deck/images/thumb`),
 * so the page never fetches a remote address itself — the rule
 * `DeckSlide.tsx` keeps for slides.
 *
 * @module shared/ui/canvas/DeckVisuals
 */

import React, { useEffect, useMemo, useState } from 'react';
import { mediaUrl } from '../media';
import type { CanvasHost, DeckImageCandidate } from './host';
import {
  INFOGRAPHICS, infographicInfo, sampleInfographic, toInfographicKind, type Deck, type DeckImage, type DesignBrief, type ImageMask,
  type InfoItem, type InfographicKind, type Slide,
} from './deck-model';
import { DECK_THEMES, themeContrastProblems, themeOfDeck } from './deck-themes';
import { ICON_NAMES, findIcons, iconPath } from './deck-icons';
import { makeVisual, paletteFromBrand, planDesign } from './deck-design';
import { DeckSlide } from './DeckSlide';
import { pickImage } from './export';
import './deck-visuals.css';

function message(err: unknown): string { return err instanceof Error ? err.message : String(err); }

// ── The infographic gallery ──────────────────────────────────────────

export function InfographicGallery({ deck, onPick }: { deck: Deck; onPick: (kind: InfographicKind) => void }): React.ReactElement {
  return (
    <div className="adv-gallery" role="list" aria-label="Infographics">
      {INFOGRAPHICS.map(info => (
        <button key={info.id} role="listitem" className="adv-gallery-item" title={`${info.label}: ${info.hint} (${info.min}–${info.max} items)`} onClick={() => onPick(info.id)}>
          <DeckSlide deck={{ ...deck, slides: [{ id: 'preview', layout: 'infographic', title: info.label, infographic: sampleInfographic(info.id) }] }} index={0} width={136} />
          <span>{info.label}</span>
        </button>
      ))}
    </div>
  );
}

// ── Infographic items ────────────────────────────────────────────────

/** "title | text | value | icon", one item per line; "; " inside text is a line break. */
export function itemsToText(items: InfoItem[] | undefined): string {
  return (items ?? []).map(it => [it.title, (it.text ?? '').replace(/\n/g, '; '), it.value ?? '', it.icon ?? ''].join(' | ').replace(/(\s\|\s*)+$/, '')).join('\n');
}

export function textToItems(text: string, previous: InfoItem[] = []): InfoItem[] {
  return text.split('\n').map(l => l.trim()).filter(Boolean).map((line, i) => {
    const [title = '', body = '', value = '', icon = ''] = line.split('|').map(s => s.trim());
    const prev = previous[i];
    return {
      title, ...(body ? { text: body.replace(/;\s*/g, '\n') } : {}), ...(value ? { value } : {}), ...(icon ? { icon } : {}),
      ...(prev?.image ? { image: prev.image } : {}),
    };
  });
}

export function InfographicFields({ slide, patch, host }: { slide: Slide; patch: (f: Record<string, unknown>) => void; host: CanvasHost }): React.ReactElement {
  const ig = slide.infographic ?? { kind: 'process' as InfographicKind, items: [] };
  const info = infographicInfo(ig.kind);
  const [draft, setDraft] = useState(itemsToText(ig.items));
  const [editing, setEditing] = useState(false);
  const [iconFor, setIconFor] = useState<number | null>(null);
  useEffect(() => { if (!editing) setDraft(itemsToText(ig.items)); }, [ig.items, editing]);
  const set = (next: Partial<typeof ig>): void => patch({ infographic: { ...ig, ...next } });
  return (
    <fieldset className="adk-group adv-ig">
      <legend>Infographic</legend>
      <label className="adk-field"><span className="adk-field-label">Kind</span>
        <select value={ig.kind} onChange={e => set({ kind: toInfographicKind(e.target.value) ?? ig.kind })}>
          {INFOGRAPHICS.map(i => <option key={i.id} value={i.id}>{i.label} — {i.hint}</option>)}
        </select>
      </label>
      <label className="adk-field">
        <span className="adk-field-label">Items <span className="adk-hint">— one per line: title | text | value | icon · {info.min}–{info.max} items{info.uses.includes('value') ? ' · value is a number, % or date' : ''}</span></span>
        <textarea rows={7} value={draft} aria-label="Infographic items" onFocus={() => setEditing(true)}
          onBlur={() => { setEditing(false); setDraft(itemsToText(ig.items)); }}
          onChange={(e) => { setDraft(e.target.value); set({ items: textToItems(e.target.value, ig.items) }); }} />
      </label>
      {(ig.kind === 'cycle' || ig.kind === 'radial' || ig.kind === 'semicircle' || ig.kind === 'venn') && (
        <label className="adk-field"><span className="adk-field-label">Centre label</span>
          <input value={ig.centre ?? ''} onChange={e => set({ centre: e.target.value || undefined })} /></label>
      )}
      {ig.kind === 'matrix' && (
        <div className="adk-row">
          <input placeholder="x-axis" value={ig.axes?.[0] ?? ''} onChange={e => set({ axes: [e.target.value, ig.axes?.[1] ?? ''] })} aria-label="X axis" />
          <input placeholder="y-axis" value={ig.axes?.[1] ?? ''} onChange={e => set({ axes: [ig.axes?.[0] ?? '', e.target.value] })} aria-label="Y axis" />
        </div>
      )}
      {info.uses.includes('icon') && (
        <div className="adv-icon-row" aria-label="Item icons">
          {ig.items.map((it, i) => (
            <button key={i} className="aw-btn adv-icon-chip" title={`Icon for "${it.title}"`} onClick={() => setIconFor(iconFor === i ? null : i)}>
              {it.icon && iconPath(it.icon) ? <IconSvg name={it.icon} /> : <span>{i + 1}</span>}
            </button>
          ))}
        </div>
      )}
      {iconFor !== null && ig.items[iconFor] && (
        <IconPicker initial={ig.items[iconFor]!.title} onPick={(name) => { set({ items: ig.items.map((it, j) => (j === iconFor ? { ...it, icon: name } : it)) }); setIconFor(null); }} onClose={() => setIconFor(null)} />
      )}
      {(ig.kind === 'team' || ig.kind === 'quote-photo' || ig.kind === 'before-after') && host.deckMedia && (
        <div className="adv-photos">
          {ig.items.map((it, i) => (
            <PictureTools key={i} host={host} label={`Photo: ${it.title || `item ${i + 1}`}`} image={it.image} compact
              onImage={(img) => set({ items: ig.items.map((x, j) => (j === i ? { ...x, ...(img ? { image: img } : { image: undefined }) } : x)) })} />
          ))}
        </div>
      )}
    </fieldset>
  );
}

// ── Icons ────────────────────────────────────────────────────────────

function IconSvg({ name, size = 18 }: { name: string; size?: number }): React.ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={iconPath(name) ?? ''} />
    </svg>
  );
}

export function IconPicker({ initial = '', onPick, onClose }: { initial?: string; onPick: (name: string) => void; onClose: () => void }): React.ReactElement {
  const [q, setQ] = useState(initial);
  const hits = useMemo(() => (q.trim() ? findIcons(q, 48).map(h => h.name) : ICON_NAMES.slice(0, 48)), [q]);
  return (
    <div className="adk-pop adv-icons" role="dialog" aria-label="Icons">
      <div className="adk-row"><input autoFocus value={q} placeholder="Search icons (growth, security, team…)" onChange={e => setQ(e.target.value)} aria-label="Search icons" />
        <button className="aw-btn" onClick={onClose}>Close</button></div>
      <div className="adv-icon-grid">
        {hits.map(n => <button key={n} className="adv-icon" title={n} aria-label={n} onClick={() => onPick(n)}><IconSvg name={n} size={22} /></button>)}
      </div>
      <p className="adk-hint">{ICON_NAMES.length} icons from Lucide (ISC licence).</p>
    </div>
  );
}

// ── Pictures ─────────────────────────────────────────────────────────

const ART = ['mesh', 'circles', 'waves', 'grid', 'blocks'] as const;

async function fileData(file: File): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

/**
 * A picture's source: search licensed pictures online, a project file, an
 * upload, generated art, or asking AICO to generate one — and its cut
 * (mask) and side where the layout uses them. `onImage(undefined)` removes it.
 */
export function PictureTools({ host, image, onImage, label = 'Picture', masks, sides, compact, slot }: {
  host: CanvasHost; image: DeckImage | undefined; onImage: (img: DeckImage | undefined) => void; label?: string;
  masks?: boolean; sides?: boolean; compact?: boolean; slot?: { w: number; h: number };
}): React.ReactElement {
  const [open, setOpen] = useState<'search' | 'project' | 'art' | 'generate' | null>(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [results, setResults] = useState<DeckImageCandidate[] | null>(null);
  const [files, setFiles] = useState<{ path: string; bytes: number }[] | null>(null);
  const media = host.deckMedia;
  const keep = (img: DeckImage): DeckImage => ({ ...img, ...(image?.mask ? { mask: image.mask } : {}), ...(image?.side ? { side: image.side } : {}) });
  const run = async (fn: () => Promise<void>): Promise<void> => { setBusy(true); setErr(null); try { await fn(); } catch (e) { setErr(message(e)); } finally { setBusy(false); } };
  const search = (): Promise<void> => run(async () => { setResults((await media!.search(q, { ...(slot ? { slot } : {}) })).candidates); });
  const upload = async (): Promise<void> => {
    const file = await pickImage();
    if (!file || !media) return;
    await run(async () => { onImage(keep(await media.upload({ name: file.name, data: await fileData(file) }))); setOpen(null); });
  };
  return (
    <div className={`adv-pic${compact ? ' is-compact' : ''}`}>
      <div className="adv-pic-head">
        <span className="adv-pic-label">{label}</span>
        {image && <span className="adv-pic-credit" title={image.sourceUrl ?? ''}>{image.src.startsWith('art:') ? `Generated art (${image.src.slice(4)})` : image.credit || image.license ? `${image.credit ?? ''}${image.license ? ` · ${image.license}` : ''}` : image.src.startsWith('data:') ? 'Embedded picture' : 'Picture'}</span>}
      </div>
      <div className="adk-row adv-pic-actions">
        {media && <button className="aw-btn adk-btn" onClick={() => setOpen(open === 'search' ? null : 'search')}>Search online</button>}
        {media && <button className="aw-btn adk-btn" onClick={() => { setOpen(open === 'project' ? null : 'project'); if (!files) void run(async () => setFiles(await media.projectFiles())); }}>Project files</button>}
        {media && <button className="aw-btn adk-btn" onClick={() => void upload()}>Upload…</button>}
        <button className="aw-btn adk-btn" onClick={() => setOpen(open === 'art' ? null : 'art')}>Art</button>
        <button className="aw-btn adk-btn" onClick={() => setOpen(open === 'generate' ? null : 'generate')}>Generate…</button>
        {image && <button className="aw-btn adk-btn" onClick={() => onImage(undefined)}>Remove</button>}
      </div>
      {(masks || sides) && image && (
        <div className="adk-row">
          {masks && (
            <label>Cut <select value={image.mask ?? 'rect'} onChange={e => onImage({ ...image, mask: e.target.value === 'rect' ? undefined : e.target.value as ImageMask })}>
              {['rect', 'rounded', 'circle', 'hexagon', 'diagonal'].map(m => <option key={m} value={m}>{m === 'rect' ? 'none' : m}</option>)}
            </select></label>
          )}
          {sides && (
            <label>Side <select value={image.side ?? 'left'} onChange={e => onImage({ ...image, side: e.target.value as 'left' | 'right' })}>
              <option value="left">left</option><option value="right">right</option>
            </select></label>
          )}
        </div>
      )}
      {image && (
        <label className="adk-field"><span className="adk-field-label">Alt text</span>
          <input value={image.alt ?? ''} placeholder="What the picture shows" onChange={e => onImage({ ...image, alt: e.target.value })} /></label>
      )}
      {err && <p className="adk-error">{err}</p>}
      {open === 'search' && media && (
        <div className="adv-panel">
          <div className="adk-row">
            <input value={q} placeholder="What should it show? (engineers in a server room)" onChange={e => setQ(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && q.trim()) void search(); }} aria-label="Search pictures" />
            <button className="aw-btn aw-btn-primary" disabled={busy || !q.trim()} onClick={() => void search()}>{busy ? 'Searching…' : 'Search'}</button>
          </div>
          <p className="adk-hint">Openverse and Wikimedia Commons (CC0, public domain, CC BY, CC BY-SA), or Pexels/Unsplash with a key stored in the vault as "pexels"/"unsplash". The credit is added to the slide.</p>
          {results && !results.length && <p className="adk-hint">Nothing found — try simpler words.</p>}
          <div className="adv-results">
            {results?.map(c => (
              <button key={c.url} className="adv-result" disabled={busy} title={`${c.title}${c.creator ? ` — ${c.creator}` : ''} · ${c.license} · ${c.why}`}
                onClick={() => void run(async () => { onImage(keep(await media.place(c.url))); setOpen(null); })}>
                {c.thumb ? <img src={mediaUrl(`/api/deck/images/thumb?u=${encodeURIComponent(c.thumb)}`)} alt={c.title} loading="lazy" /> : <span className="adv-noprev">{c.title}</span>}
                <span className="adv-lic">{c.license}{c.width ? ` · ${c.width}×${c.height}` : ''}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {open === 'project' && media && (
        <div className="adv-panel adv-files">
          {!files ? <p className="adk-hint">Looking…</p> : !files.length ? <p className="adk-hint">No PNG, JPEG or GIF files in the project.</p> : files.map(f => (
            <button key={f.path} className="adv-file" disabled={busy} onClick={() => void run(async () => { onImage(keep(await media.projectFile(f.path))); setOpen(null); })}>{f.path}</button>
          ))}
        </div>
      )}
      {open === 'art' && (
        <div className="adv-panel adk-row">
          {ART.map(a => <button key={a} className="aw-btn adk-btn" onClick={() => { onImage(keep({ src: `art:${a}`, alt: image?.alt ?? 'Abstract pattern in the theme colours' })); setOpen(null); }}>{a}</button>)}
        </div>
      )}
      {open === 'generate' && <GenerateAsk host={host} label={label} onDone={() => setOpen(null)} />}
    </div>
  );
}

/** Generating costs money on the person's own key, so it goes through AICO (GenerateImage reports the cost) rather than a silent call. */
function GenerateAsk({ host, label, onDone }: { host: CanvasHost; label: string; onDone: () => void }): React.ReactElement {
  const [prompt, setPrompt] = useState('');
  return (
    <div className="adv-panel">
      <textarea rows={3} value={prompt} placeholder="Describe the picture (subject, style, colours)" onChange={e => setPrompt(e.target.value)} aria-label="Picture description" />
      <div className="adk-row"><span className="adk-hint">AICO generates it with your image model (costs money; the cost is shown) and places it.</span>
        <button className="aw-btn aw-btn-primary" disabled={!prompt.trim()} onClick={() => { host.ask(`Generate a picture for the deck (${label}): ${prompt.trim()}. Use GenerateImage, save it in the project, and place it with set_slides.`); onDone(); }}>Ask AICO</button></div>
    </div>
  );
}

export function ImagesField({ host, slide, patch }: { host: CanvasHost; slide: Slide; patch: (f: Record<string, unknown>) => void }): React.ReactElement {
  const imgs = slide.images ?? [];
  const setAt = (i: number, img: DeckImage | undefined): void => {
    const next = imgs.slice();
    if (img) next[i] = img; else next.splice(i, 1);
    patch({ images: next.length ? next : null });
  };
  return (
    <fieldset className="adk-group">
      <legend>Pictures ({imgs.length}/4)</legend>
      {imgs.map((im, i) => (
        <div key={i}>
          <PictureTools host={host} label={`Picture ${i + 1}`} image={im} onImage={img => setAt(i, img)} compact masks />
          <label className="adk-field"><span className="adk-field-label">Caption</span><input value={im.caption ?? ''} onChange={e => setAt(i, { ...im, caption: e.target.value || undefined })} /></label>
        </div>
      ))}
      {imgs.length < 4 && <PictureTools host={host} label="Add a picture" image={undefined} onImage={img => img && patch({ images: [...imgs, img] })} compact />}
    </fieldset>
  );
}

// ── Make this slide visual ───────────────────────────────────────────

export function MakeVisualButton({ slide, patch }: { slide: Slide; patch: (f: Record<string, unknown>) => void }): React.ReactElement | null {
  if (!['bullets', 'two-column', 'comparison', 'agenda', 'kpi', 'timeline'].includes(slide.layout)) return null;
  const next = makeVisual(slide);
  if (!next) return null;
  return (
    <button className="aw-btn adk-btn adv-make" title={`Turn this slide into a ${infographicInfo(next.infographic!.kind).label.toLowerCase()} — every word kept`}
      onClick={() => patch({ bullets: null, left: null, right: null, kpis: null, timeline: null, ...next, ...(next.body ? {} : { body: null }) })}>
      Make this slide visual
    </button>
  );
}

// ── Design brief and palette ─────────────────────────────────────────

const SLOTS = ['accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'dk2', 'lt2'] as const;
const SLOT_NAMES: Record<string, string> = { accent1: 'Accent 1', accent2: 'Accent 2', accent3: 'Accent 3', accent4: 'Accent 4', accent5: 'Accent 5', dk2: 'Titles / fields', lt2: 'Cards' };

export function DesignPanel({ host, deck, title, meta, onClose }: {
  host: CanvasHost; deck: Deck; title: string; meta: (patch: Partial<Pick<Deck, 'theme' | 'palette' | 'brief' | 'fonts'>>) => void; onClose: () => void;
}): React.ReactElement {
  const [brief, setBrief] = useState<DesignBrief>(deck.brief ?? {});
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const theme = themeOfDeck(deck);
  const plan = useMemo(() => planDesign(brief, { title, type: deck.type }), [brief, title, deck.type]);
  const problems = themeContrastProblems(theme);
  const setB = (p: Partial<DesignBrief>): void => setBrief(b => ({ ...b, ...p }));
  const setBrand = (p: Partial<NonNullable<DesignBrief['brand']>>): void => setBrief(b => ({ ...b, brand: { ...b.brand, ...p } }));
  const readBrand = async (): Promise<void> => {
    if (!host.deckMedia || !brief.brand?.url) return;
    setBusy(true); setNote(null);
    try {
      const r = await host.deckMedia.brand(brief.brand.url, deck.theme);
      setBrand({ colors: r.brand.colors, ...(r.brand.name && !brief.brand.name ? { name: r.brand.name } : {}) });
      setNote(r.brand.colors.length ? `Found ${r.brand.colors.join(' ')}${r.brand.font ? ` and the font ${r.brand.font}` : ''}.` : r.brand.notes.join(' '));
    } catch (e) { setNote(message(e)); } finally { setBusy(false); }
  };
  return (
    <div className="adk-pop adv-design" role="dialog" aria-label="Design brief">
      <div className="adk-pop-title">Design brief</div>
      <div className="adv-grid2">
        <label className="adk-field"><span className="adk-field-label">Audience</span><input value={brief.audience ?? ''} placeholder="investors, IT managers, new staff…" onChange={e => setB({ audience: e.target.value })} /></label>
        <label className="adk-field"><span className="adk-field-label">Industry / organisation</span><input value={brief.industry ?? ''} placeholder="fintech startup, NHS trust…" onChange={e => setB({ industry: e.target.value })} /></label>
        <label className="adk-field"><span className="adk-field-label">Tone</span><input value={brief.tone ?? ''} placeholder="bold, formal, friendly…" onChange={e => setB({ tone: e.target.value })} /></label>
        <label className="adk-field"><span className="adk-field-label">Pictures</span>
          <select value={brief.imageStyle ?? ''} onChange={e => setB({ imageStyle: (e.target.value || undefined) as DesignBrief['imageStyle'] })}>
            <option value="">(suggested: {plan.imageStyle})</option><option value="photo">Photos</option><option value="illustration">Illustrations</option><option value="abstract">Abstract art</option><option value="none">None</option>
          </select></label>
        <label className="adk-field"><span className="adk-field-label">Brand name</span><input value={brief.brand?.name ?? ''} onChange={e => setBrand({ name: e.target.value })} /></label>
        <label className="adk-field"><span className="adk-field-label">Brand website</span>
          <span className="adk-row"><input value={brief.brand?.url ?? ''} placeholder="example.com" onChange={e => setBrand({ url: e.target.value })} />
            {host.deckMedia && <button className="aw-btn" disabled={busy || !brief.brand?.url} onClick={() => void readBrand()}>{busy ? 'Reading…' : 'Read colours'}</button>}</span></label>
      </div>
      {note && <p className="adk-hint">{note}</p>}
      {!!brief.brand?.colors?.length && (
        <div className="adk-row adv-swatches">{brief.brand.colors.map(c => <span key={c} className="adv-swatch" style={{ background: c }} title={c} />)}</div>
      )}
      <p className="adk-hint">Suggested: <b>{plan.why}</b>. Layout mix: {plan.layoutMix.join(', ')}.</p>
      <div className="adk-row">
        <span className="adk-spacer" />
        <button className="aw-btn" onClick={() => meta({ brief })}>Save brief</button>
        <button className="aw-btn aw-btn-primary" onClick={() => meta({
          brief, theme: plan.theme,
          ...(brief.brand?.colors?.length ? { palette: paletteFromBrand(brief.brand.colors, plan.theme) } : {}),
        })}>Apply suggestion</button>
      </div>
      <div className="adk-pop-title">Palette</div>
      <div className="adv-palette">
        {SLOTS.map(s => (
          <label key={s} className="adv-slot" title={SLOT_NAMES[s]}>
            <input type="color" value={theme.scheme[s].toLowerCase()} onChange={e => meta({ palette: { ...(deck.palette ?? {}), [s]: e.target.value.toUpperCase() } })} />
            <span>{SLOT_NAMES[s]}</span>
          </label>
        ))}
      </div>
      {problems.length > 0 && <ul className="adk-problems">{problems.map((p, i) => <li key={i} className="is-err">{p}</li>)}</ul>}
      <div className="adk-row">
        <select value={deck.theme} onChange={e => meta({ theme: e.target.value })} aria-label="Theme">{DECK_THEMES.map(t => <option key={t.id} value={t.id}>{t.name}{t.dark ? ' (dark)' : ''}</option>)}</select>
        {deck.palette && <button className="aw-btn" onClick={() => meta({ palette: {} })}>Theme colours</button>}
        <span className="adk-spacer" />
        <button className="aw-btn" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
