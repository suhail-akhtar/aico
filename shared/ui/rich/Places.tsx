/**
 * ```places — local results on a real map.
 *
 * Leaflet over OpenStreetMap's standard tiles. Markers are `divIcon`s (the
 * rating pills), so no marker image ships and the bundler's broken default-icon
 * path never comes up. Tiles are only images: if they cannot load — offline, or
 * a policy that blocks them — the markers still sit on a plain background and
 * every place is still in the list.
 *
 * Inline, the cards overlay the bottom of the map the way a phone map does; the
 * Expand button opens a full-window view with the list beside the map, an
 * "Open now" filter and zoom controls.
 *
 * @module shared/ui/rich/Places
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useWidgetExpanded } from '../Widget';
import { Arriving, Carousel, ExtLink, Icon, Overlay, SafeImg, Stars, useParsed } from './common';
import { directionsLink, parsePlaces, placeLink, type Place, type PlacesSpec } from './specs';

const OSM_TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors';

type Selection = { id: number; from: 'map' | 'list' } | null;

export function Places({ source, streaming = false }: { source: string; streaming?: boolean }): React.ReactElement {
  const { spec, waiting } = useParsed(source, streaming, parsePlaces);
  if (waiting || !spec) return <Arriving what="Places" />;
  return <PlacesView spec={spec} />;
}

function PlacesView({ spec }: { spec: PlacesSpec }): React.ReactElement {
  const frameExpanded = useWidgetExpanded();
  const [selected, setSelected] = useState<Selection>(null);
  const [full, setFull] = useState(false);
  // Memoised: the map rebuilds its markers when this array changes identity.
  const mapped = useMemo(() => spec.places.filter(p => p.lat !== undefined), [spec]);
  const close = useCallback(() => setFull(false), []);

  if (frameExpanded) return <FullView spec={spec} selected={selected} onSelect={setSelected} inFrame />;

  const title = spec.title ?? (spec.places.length === 1 ? spec.places[0]!.name : `${spec.places.length} places`);

  return (
    <div className="aw aw-places">
      {mapped.length > 0 ? (
        <div className="aw-places-stage">
          <PlacesMap
            places={mapped}
            spec={spec}
            selected={selected}
            onSelect={id => setSelected({ id, from: 'map' })}
            padBottom={128}
          />
          <div className="aw-map-chip aw-map-title" title={title}>
            <Icon name="pin" size={13} /> <span>{title}</span>
          </div>
          <button type="button" className="aw-map-chip aw-map-expand" onClick={() => setFull(true)} aria-label="Expand the map">
            <Icon name="expand" size={13} /> <span>Expand</span>
          </button>
          <div className="aw-place-row">
            <PlaceCards places={spec.places} selected={selected} onSelect={id => setSelected({ id, from: 'list' })} />
          </div>
        </div>
      ) : (
        <>
          <div className="aw-heading">{title}</div>
          <p className="aw-note">No coordinates were given, so there is no map — the places are listed below.</p>
          <PlaceCards places={spec.places} selected={selected} onSelect={id => setSelected({ id, from: 'list' })} />
        </>
      )}
      {full && (
        <Overlay onClose={close} label={title}>
          <FullView spec={spec} selected={selected} onSelect={setSelected} onClose={close} />
        </Overlay>
      )}
    </div>
  );
}

function PlaceCards({ places, selected, onSelect }: {
  places: Place[]; selected: Selection; onSelect: (id: number) => void;
}): React.ReactElement {
  const scroller = useRef<HTMLDivElement | null>(null);
  // A marker picked on the map brings its card into view.
  useEffect(() => {
    if (!selected || selected.from !== 'map') return;
    const el = scroller.current?.querySelector<HTMLElement>(`[data-place="${selected.id}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }, [selected]);
  return (
    <Carousel label="Places" scrollRef={scroller}>
      {places.map(p => (
        <div
          key={p.id}
          data-place={p.id}
          role="listitem"
          className={`aw-place-card${selected?.id === p.id ? ' is-active' : ''}`}
          tabIndex={0}
          onClick={() => onSelect(p.id)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(p.id); } }}
        >
          <div className="aw-place-thumb">
            <SafeImg src={p.image} alt="" fallback={<PlaceGlyph place={p} />} />
          </div>
          <div className="aw-place-body">
            <div className="aw-place-name" title={p.name}>{p.name}</div>
            <div className="aw-place-meta">
              <Stars rating={p.rating} reviews={p.reviews} compact />
              {p.rating !== undefined && p.category && <span className="aw-dot">·</span>}
              {p.category && <span className="aw-ellipsis">{p.category}</span>}
            </div>
            <div className="aw-place-meta">
              <OpenState open={p.open} />
              {p.open !== undefined && p.price && <span className="aw-dot">·</span>}
              {p.price && <span>{p.price}</span>}
              {p.open === undefined && !p.price && p.address && <span className="aw-ellipsis aw-muted">{p.address}</span>}
            </div>
          </div>
          {placeLink(p) && (
            <ExtLink href={placeLink(p)} className="aw-place-link" title={p.url ? 'Open website' : 'Open in OpenStreetMap'}
              onClick={e => e.stopPropagation()}>
              <Icon name="external" size={12} />
            </ExtLink>
          )}
        </div>
      ))}
    </Carousel>
  );
}

function OpenState({ open, hours }: { open?: boolean; hours?: string }): React.ReactElement | null {
  if (open === undefined) return hours ? <span className="aw-muted">{hours}</span> : null;
  return (
    <span className={open ? 'aw-open' : 'aw-closed'}>
      {open ? 'Open' : 'Closed'}{hours && <span className="aw-muted"> · {hours}</span>}
    </span>
  );
}

/** A category-flavoured glyph for places without a photo. */
function PlaceGlyph({ place }: { place: Place }): React.ReactElement {
  const c = (place.category ?? '').toLowerCase();
  const emoji = /coffee|caf[eé]/.test(c) ? '☕' : /bar|pub|wine|brew/.test(c) ? '🍷'
    : /bak|pastr|dessert|ice cream/.test(c) ? '🥐' : /pizza/.test(c) ? '🍕' : /sushi|japan/.test(c) ? '🍣'
    : /burger/.test(c) ? '🍔' : /restaurant|food|dining|grill|bistro|kitchen|eat/.test(c) ? '🍽️'
    : /hotel|hostel|inn|lodg/.test(c) ? '🏨' : /museum|gallery/.test(c) ? '🏛️' : /park|garden/.test(c) ? '🌳'
    : /gym|fitness/.test(c) ? '🏋️' : /shop|store|market|mall/.test(c) ? '🛍️' : /hospital|clinic|pharm|doctor/.test(c) ? '🏥'
    : /school|universit|college/.test(c) ? '🎓' : /gas|fuel|petrol/.test(c) ? '⛽' : '';
  return <span className="aw-place-glyph" aria-hidden="true">{emoji || <Icon name="pin" size={20} />}</span>;
}

// ── The map ──────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

/**
 * Keep pin labels from printing over each other.
 *
 * Pills always show; a label is dropped when it would overlap a pill or a
 * label already placed — the selected place first, then by rating — and one
 * that would run off the right edge is flipped to the left of its pill. A
 * dropped label comes back on hover.
 */
function declutter(root: HTMLElement): void {
  const box = root.getBoundingClientRect();
  if (!box.width) return;
  const pins = [...root.querySelectorAll<HTMLElement>('.aw-pin')];
  const pills = pins.map(p => p.querySelector('.aw-pin-pill')!.getBoundingClientRect());
  const placed: DOMRect[] = [];
  const order = pins.map((pin, i) => ({ pin, i }))
    .sort((a, b) => Number(b.pin.classList.contains('is-active')) - Number(a.pin.classList.contains('is-active'))
      || Number(b.pin.dataset.rating ?? -1) - Number(a.pin.dataset.rating ?? -1));
  const hit = (a: DOMRect, b: DOMRect): boolean => a.left < b.right + 2 && a.right + 2 > b.left && a.top < b.bottom && a.bottom > b.top;
  for (const { pin, i } of order) {
    const label = pin.querySelector<HTMLElement>('.aw-pin-label');
    if (!label) continue;
    label.classList.remove('is-hidden', 'is-left');
    const clashes = (r: DOMRect): boolean =>
      pills.some((p, j) => j !== i && hit(p, r)) || placed.some(p => hit(p, r)) || r.left < box.left || r.right > box.right - 4;
    let r = label.getBoundingClientRect();
    if (clashes(r)) {
      // The other side of the pill, before giving up on the label.
      label.classList.add('is-left');
      const left = label.getBoundingClientRect();
      if (!clashes(left)) r = left;
      else label.classList.remove('is-left');
    }
    if (clashes(r) && !pin.classList.contains('is-active')) label.classList.add('is-hidden');
    else placed.push(label.getBoundingClientRect());
  }
}

function pinIcon(p: Place, active: boolean, showLabel: boolean): L.DivIcon {
  const pill = p.rating !== undefined
    ? `<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path d="M8 1.6l1.9 4 4.4.5-3.3 3 .9 4.3L8 11.3l-3.9 2.1.9-4.3-3.3-3 4.4-.5z" fill="currentColor"/></svg>${p.rating.toFixed(1)}`
    : '<span class="aw-pin-dot"></span>';
  const label = showLabel || active ? `<span class="aw-pin-label">${escapeHtml(p.name)}</span>` : '';
  return L.divIcon({
    className: 'aw-pin-wrap',
    html: `<div class="aw-pin${active ? ' is-active' : ''}${p.open === false ? ' is-closed' : ''}" data-rating="${p.rating ?? -1}"><span class="aw-pin-pill">${pill}</span>${label}</div>`,
    iconSize: undefined,
    iconAnchor: undefined,
  });
}

interface MapProps {
  places: Place[];
  spec: PlacesSpec;
  selected: Selection;
  onSelect: (id: number) => void;
  /** Room kept free at the bottom (the card row) when fitting and panning. */
  padBottom?: number;
  wheelZoom?: boolean;
  onReady?: (map: L.Map, fit: () => void) => void;
}

function PlacesMap({ places, spec, selected, onSelect, padBottom = 0, wheelZoom = false, onReady }: MapProps): React.ReactElement {
  const host = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markers = useRef(new Map<number, L.Marker>());
  const [tilesFailed, setTilesFailed] = useState(false);
  const fitRef = useRef<() => void>(() => {});
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;
  const showLabels = places.length <= 12;
  /** The selection this map has already acted on — not the one it was opened with. */
  const handled = useRef(selected);
  /** Set once the reader (or a selection) moves the map; until then a resize re-fits. */
  const touched = useRef(false);
  const fitting = useRef(false);
  const tidy = useRef(() => {});
  tidy.current = () => { requestAnimationFrame(() => { if (host.current) declutter(host.current); }); };

  const fit = useCallback(() => {
    const map = mapRef.current;
    if (!map || places.length === 0) return;
    fitting.current = true;
    try { place(map); } finally { fitting.current = false; }
  }, [places, spec.center, spec.zoom, padBottom]);

  const place = (map: L.Map): void => {
    if (spec.center && spec.zoom) { map.setView(spec.center, spec.zoom); return; }
    if (places.length === 1) {
      map.setView([places[0]!.lat!, places[0]!.lng!], spec.zoom ?? 15);
      if (padBottom) map.panBy([0, padBottom / 2], { animate: false });
      return;
    }
    const bounds = L.latLngBounds(places.map(p => [p.lat!, p.lng!] as [number, number]));
    map.fitBounds(bounds, { paddingTopLeft: [48, 56], paddingBottomRight: [48, padBottom + 40], maxZoom: 16, animate: false });
  };

  fitRef.current = fit;

  // Create the map once; the places are fixed for the life of a block.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const map = L.map(el, {
      zoomControl: false,
      attributionControl: true,
      scrollWheelZoom: wheelZoom,
      worldCopyJump: true,
      zoomSnap: 0.5,
    });
    map.attributionControl.setPrefix(false);
    let loaded = 0, failed = 0;
    const tiles = L.tileLayer(OSM_TILES, {
      maxZoom: 19,
      attribution: OSM_ATTRIBUTION,
      crossOrigin: false,
    });
    tiles.on('tileload', () => { loaded++; setTilesFailed(false); });
    tiles.on('tileerror', () => { failed++; if (loaded === 0 && failed >= 2) setTilesFailed(true); });
    tiles.addTo(map);
    mapRef.current = map;
    map.on('zoomend moveend', () => tidy.current());
    map.on('movestart zoomstart', () => { if (!fitting.current) touched.current = true; });
    fit();
    onReady?.(map, fit);
    // A map sized while hidden, or whose container later grows, draws grey
    // until told its size changed.
    // Until someone has moved it, a resize re-fits too — a map first laid out
    // at the wrong size (a panel still opening) would otherwise keep that zoom.
    const ro = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => { map.invalidateSize({ animate: false }); if (!touched.current) fitRef.current(); })
      : undefined;
    ro?.observe(el);
    return () => { ro?.disconnect(); map.remove(); mapRef.current = null; markers.current.clear(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Markers: rebuilt when the visible set changes (the "Open now" filter).
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    for (const m of markers.current.values()) m.remove();
    markers.current.clear();
    for (const p of places) {
      const marker = L.marker([p.lat!, p.lng!], {
        icon: pinIcon(p, selected?.id === p.id, showLabels),
        keyboard: true,
        title: p.name,
        riseOnHover: true,
        zIndexOffset: selected?.id === p.id ? 1000 : 0,
      });
      marker.on('click', () => selectRef.current(p.id));
      marker.addTo(map);
      markers.current.set(p.id, marker);
    }
    tidy.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [places]);

  // Selection: restyle the pins and bring the chosen one into view.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    for (const p of places) {
      const m = markers.current.get(p.id);
      if (!m) continue;
      const active = selected?.id === p.id;
      m.setIcon(pinIcon(p, active, showLabels));
      m.setZIndexOffset(active ? 1000 : 0);
    }
    tidy.current();
    if (!selected || selected === handled.current) return;
    handled.current = selected;
    const p = places.find(x => x.id === selected.id);
    if (!p) return;
    const size = map.getSize();
    const pt = map.latLngToContainerPoint([p.lat!, p.lng!]);
    const margin = 40;
    const inView = pt.x > margin && pt.x < size.x - margin && pt.y > margin && pt.y < size.y - padBottom - margin;
    if (selected.from === 'list' || !inView) {
      // Centre it in the part of the map the cards do not cover.
      const target = map.project([p.lat!, p.lng!], map.getZoom()).add([0, padBottom / 2]);
      map.panTo(map.unproject(target, map.getZoom()), { animate: true, duration: 0.4 });
    }
  }, [selected, places, padBottom, showLabels]);

  return (
    <div className={`aw-map${tilesFailed ? ' is-offline' : ''}`}>
      <div ref={host} className="aw-map-host" />
      {tilesFailed && <div className="aw-map-offline">Map tiles could not load — markers are shown without the map.</div>}
    </div>
  );
}

// ── The full-window view ─────────────────────────────────────────────

function FullView({ spec, selected, onSelect, onClose, inFrame = false }: {
  spec: PlacesSpec; selected: Selection; onSelect: (s: Selection) => void; onClose?: () => void; inFrame?: boolean;
}): React.ReactElement {
  const [openOnly, setOpenOnly] = useState(false);
  const [sortByRating, setSortByRating] = useState(false);
  const mapApi = useRef<{ map: L.Map; fit: () => void } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const anyOpenKnown = spec.places.some(p => p.open !== undefined);
  const visible = useMemo(() => {
    let list = openOnly ? spec.places.filter(p => p.open === true) : spec.places;
    if (sortByRating) list = [...list].sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1));
    return list;
  }, [spec.places, openOnly, sortByRating]);
  const mapped = useMemo(() => visible.filter(p => p.lat !== undefined), [visible]);

  useEffect(() => {
    if (!selected || selected.from !== 'map') return;
    listRef.current?.querySelector<HTMLElement>(`[data-place="${selected.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [selected]);

  const count = visible.length;
  return (
    <div className={`aw aw-places-full${inFrame ? ' is-in-frame' : ''}`}>
      <div className="aw-full-map">
        {mapped.length > 0 ? (
          <PlacesMap
            key={openOnly ? 'open' : 'all'}
            places={mapped}
            spec={spec}
            selected={selected}
            onSelect={id => onSelect({ id, from: 'map' })}
            wheelZoom
            onReady={(map, fit) => { mapApi.current = { map, fit }; }}
          />
        ) : <div className="aw-map aw-map-empty">No places to show on the map.</div>}
        <div className="aw-zoom" role="group" aria-label="Zoom">
          <button type="button" onClick={() => mapApi.current?.map.zoomIn()} aria-label="Zoom in"><Icon name="plus" size={15} /></button>
          <button type="button" onClick={() => mapApi.current?.map.zoomOut()} aria-label="Zoom out"><Icon name="minus" size={15} /></button>
          <button type="button" onClick={() => mapApi.current?.fit()} aria-label="Show all places"><Icon name="fit" size={15} /></button>
        </div>
      </div>
      <aside className="aw-full-list" aria-label="Places">
        <div className="aw-full-head">
          <div className="aw-full-title">
            <b>{count} {count === 1 ? 'Place' : 'Places'}</b>
            {spec.title && <span className="aw-muted aw-ellipsis">{spec.title}</span>}
          </div>
          {onClose && (
            <button type="button" className="aw-icon-btn" onClick={onClose} aria-label="Close (Esc)" title="Close (Esc)">
              <Icon name="close" size={16} />
            </button>
          )}
        </div>
        <div className="aw-chips">
          {anyOpenKnown && (
            <button type="button" className={`aw-chip${openOnly ? ' is-on' : ''}`} aria-pressed={openOnly} onClick={() => setOpenOnly(v => !v)}>
              <Icon name="clock" size={12} /> Open now
            </button>
          )}
          {spec.places.some(p => p.rating !== undefined) && (
            <button type="button" className={`aw-chip${sortByRating ? ' is-on' : ''}`} aria-pressed={sortByRating} onClick={() => setSortByRating(v => !v)}>
              <Icon name="star" size={12} /> Top rated
            </button>
          )}
        </div>
        <div className="aw-full-items" ref={listRef}>
          {count === 0 && <p className="aw-note">None of these places is marked open right now.</p>}
          {visible.map(p => (
            <div
              key={p.id}
              data-place={p.id}
              className={`aw-full-item${selected?.id === p.id ? ' is-active' : ''}`}
              tabIndex={0}
              role="button"
              onClick={() => onSelect({ id: p.id, from: 'list' })}
              onKeyDown={(e) => { if (e.key === 'Enter') onSelect({ id: p.id, from: 'list' }); }}
            >
              <div className="aw-full-text">
                <div className="aw-full-name">{p.name}</div>
                <div className="aw-place-meta">
                  <Stars rating={p.rating} reviews={p.reviews} />
                  {p.rating !== undefined && (p.category || p.price) && <span className="aw-dot">·</span>}
                  {p.category && <span>{p.category}</span>}
                  {p.category && p.price && <span className="aw-dot">·</span>}
                  {p.price && <span>{p.price}</span>}
                </div>
                {(p.open !== undefined || p.hours) && <div className="aw-place-meta"><OpenState open={p.open} hours={p.hours} /></div>}
                {p.address && <div className="aw-place-meta aw-muted">{p.address}</div>}
                {p.note && <div className="aw-full-note">{p.note}</div>}
                <div className="aw-actions" onClick={e => e.stopPropagation()}>
                  {p.url && <ExtLink href={p.url} className="aw-btn"><Icon name="globe" size={12} /> Website</ExtLink>}
                  {directionsLink(p) && <ExtLink href={directionsLink(p)} className="aw-btn"><Icon name="directions" size={12} /> Directions</ExtLink>}
                  {p.phone && <a href={`tel:${p.phone.replace(/[^\d+]/g, '')}`} className="aw-btn"><Icon name="phone" size={12} /> {p.phone}</a>}
                  {!p.url && placeLink(p) && <ExtLink href={placeLink(p)} className="aw-btn"><Icon name="pin" size={12} /> Map</ExtLink>}
                </div>
                {p.source && <div className="aw-source">via {p.source}</div>}
              </div>
              <div className="aw-full-thumb">
                <SafeImg src={p.image} alt="" fallback={<PlaceGlyph place={p} />} />
              </div>
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}
