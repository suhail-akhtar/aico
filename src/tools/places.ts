/**
 * `Places` — find real places on OpenStreetMap, ready for a ```places map.
 *
 * Keyless by design: Nominatim for text search and geocoding, Overpass for
 * "this kind of place within this distance of that point". Both are volunteer
 * run, so their policies are followed to the letter — an identifying
 * User-Agent, at most one Nominatim request per second with none in parallel
 * (see `RequestSpacer`), and answers cached so the same question is not asked
 * twice in a conversation.
 *
 * ## What OpenStreetMap does not have
 *
 * Ratings, reviews and photos. The result says so in words the model reads,
 * because the alternative is a model that "helpfully" fills `rating: 4.5` into
 * the map from nowhere. It may add those fields only from a page it actually
 * read with WebSearch/WebFetch, naming the source.
 *
 * @module tools/places
 */

import { openNow } from './opening-hours.js';
import {
  requestJson, RequestSpacer, TtlCache, fencedBlock, round, NetError,
  type SpacerClock,
} from './net.js';

export interface PlacesInput {
  query: string;
  near?: string;
  lat?: number;
  lng?: number;
  radiusKm?: number;
  limit?: number;
}

export interface Place {
  name: string;
  category?: string;
  cuisine?: string;
  address?: string;
  lat: number;
  lng: number;
  distanceKm?: number;
  openingHours?: string;
  open: boolean | null;
  phone?: string;
  website?: string;
  osmUrl?: string;
}

const NOMINATIM = 'https://nominatim.openstreetmap.org';
const OVERPASS = 'https://overpass-api.de/api/interpreter';
const OVERPASS_MIRROR = 'https://overpass.kumi.systems/api/interpreter';
const OPEN_METEO_FORECAST = 'https://api.open-meteo.com/v1/forecast';

let nominatimSpacer = new RequestSpacer(1100);
let overpassSpacer = new RequestSpacer(1000);
const geocodeCache = new TtlCache<Center | null>(60 * 60 * 1000);
const searchCache = new TtlCache<Place[]>(10 * 60 * 1000);
const offsetCache = new TtlCache<{ offset: number; timezone?: string }>(24 * 60 * 60 * 1000);

/** For the tests: fresh caches, and a clock the spacer can be driven by. */
export function resetPlacesForTests(clock?: SpacerClock): void {
  nominatimSpacer = new RequestSpacer(1100, clock);
  overpassSpacer = new RequestSpacer(1000, clock);
  geocodeCache.clear();
  searchCache.clear();
  offsetCache.clear();
}

interface Center { lat: number; lng: number; label: string; radiusKm?: number }

// ── Nominatim ────────────────────────────────────────────────────────

interface NominatimHit {
  osm_type?: string;
  osm_id?: number;
  lat: string;
  lon: string;
  name?: string;
  display_name?: string;
  category?: string;
  type?: string;
  address?: Record<string, string>;
  extratags?: Record<string, string> | null;
  boundingbox?: [string, string, string, string];
}

function nominatim(params: Record<string, string>): Promise<NominatimHit[]> {
  const qs = new URLSearchParams({ format: 'jsonv2', addressdetails: '1', extratags: '1', ...params });
  return nominatimSpacer.run(() => requestJson<NominatimHit[]>(`${NOMINATIM}/search?${qs}`, {
    what: 'OpenStreetMap search (Nominatim)',
    headers: { 'Accept-Language': 'en' },
  }));
}

async function geocode(text: string): Promise<Center | null> {
  const key = text.trim().toLowerCase();
  const cached = geocodeCache.get(key);
  if (cached !== undefined) return cached;
  const [hit] = await nominatim({ q: text, limit: '1' });
  let center: Center | null = null;
  if (hit) {
    const lat = Number(hit.lat);
    const lng = Number(hit.lon);
    let radiusKm: number | undefined;
    if (hit.boundingbox) {
      const [s, n, w, e] = hit.boundingbox.map(Number) as [number, number, number, number];
      // Half the box's diagonal: a city gets its own size, a street corner a
      // walkable radius. Clamped so a country does not become a 1,000 km search.
      radiusKm = Math.min(25, Math.max(2, haversineKm(s, w, n, e) / 2));
    }
    center = { lat, lng, label: hit.display_name ?? text, ...(radiusKm ? { radiusKm } : {}) };
  }
  geocodeCache.set(key, center);
  return center;
}

function fromNominatim(hit: NominatimHit): Place | undefined {
  const lat = Number(hit.lat);
  const lng = Number(hit.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return undefined;
  const tags = hit.extratags ?? {};
  const name = hit.name?.trim() || hit.display_name?.split(',')[0]?.trim();
  if (!name) return undefined;
  const a = hit.address ?? {};
  const street = [a.house_number, a.road].filter(Boolean).join(' ');
  const locality = a.suburb ?? a.neighbourhood ?? a.quarter;
  const city = a.city ?? a.town ?? a.village ?? a.county;
  const address = [street, locality, city].filter(Boolean).join(', ') || undefined;
  return shape({
    name,
    category: hit.type && hit.type !== 'yes' ? hit.type.replace(/_/g, ' ') : hit.category,
    tags,
    address,
    lat,
    lng,
    ...(hit.osm_type && hit.osm_id ? { osmUrl: `https://www.openstreetmap.org/${hit.osm_type}/${hit.osm_id}` } : {}),
  });
}

// ── Overpass ─────────────────────────────────────────────────────────

interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

/** Words that name a kind of place, and the OSM tags that kind carries. */
const CATEGORIES: Array<{ words: RegExp; filter: string }> = [
  { words: /\b(restaurants?|dining|diners?|eater(y|ies)|food)\b/, filter: '["amenity"="restaurant"]' },
  { words: /\b(caf[eé]s?|coffee( shops?)?|tea ?houses?)\b/, filter: '["amenity"="cafe"]' },
  { words: /\b(fast ?food|takeaways?|take-?outs?)\b/, filter: '["amenity"="fast_food"]' },
  { words: /\b(bars?|pubs?)\b/, filter: '["amenity"~"^(bar|pub)$"]' },
  { words: /\b(hotels?|motels?)\b/, filter: '["tourism"~"^(hotel|motel)$"]' },
  { words: /\b(guest ?houses?|hostels?)\b/, filter: '["tourism"~"^(guest_house|hostel)$"]' },
  { words: /\b(hospitals?)\b/, filter: '["amenity"="hospital"]' },
  { words: /\b(clinics?|doctors?)\b/, filter: '["amenity"~"^(clinic|doctors)$"]' },
  { words: /\b(pharmac(y|ies)|chemists?|drug ?stores?)\b/, filter: '["amenity"="pharmacy"]' },
  { words: /\b(atms?|cash ?machines?)\b/, filter: '["amenity"="atm"]' },
  { words: /\b(banks?)\b/, filter: '["amenity"="bank"]' },
  { words: /\b(petrol|gas|fuel|filling)( stations?| pumps?)?\b/, filter: '["amenity"="fuel"]' },
  { words: /\b(supermarkets?|grocer(y|ies)|groceries)\b/, filter: '["shop"~"^(supermarket|convenience|grocery)$"]' },
  { words: /\b(baker(y|ies))\b/, filter: '["shop"="bakery"]' },
  { words: /\b(museums?)\b/, filter: '["tourism"="museum"]' },
  { words: /\b(parks?)\b/, filter: '["leisure"="park"]' },
  { words: /\b(mosques?|masjids?)\b/, filter: '["amenity"="place_of_worship"]["religion"="muslim"]' },
  { words: /\b(churche?s?)\b/, filter: '["amenity"="place_of_worship"]["religion"="christian"]' },
  { words: /\b(temples?)\b/, filter: '["amenity"="place_of_worship"]' },
  { words: /\b(schools?)\b/, filter: '["amenity"="school"]' },
  { words: /\b(universit(y|ies)|colleges?)\b/, filter: '["amenity"~"^(university|college)$"]' },
  { words: /\b(parking|car ?parks?)\b/, filter: '["amenity"="parking"]' },
  { words: /\b(police( stations?)?)\b/, filter: '["amenity"="police"]' },
  { words: /\b(librar(y|ies))\b/, filter: '["amenity"="library"]' },
  { words: /\b(gyms?|fitness)\b/, filter: '["leisure"="fitness_centre"]' },
  { words: /\b(cinemas?|movie theat(er|re)s?)\b/, filter: '["amenity"="cinema"]' },
  { words: /\b(dentists?)\b/, filter: '["amenity"="dentist"]' },
];

const FILLER = new Set([
  'near', 'nearby', 'in', 'at', 'around', 'me', 'my', 'the', 'a', 'an', 'best', 'good', 'top', 'rated',
  'cheap', 'open', 'now', 'places', 'place', 'find', 'some', 'any', 'local', 'of', 'for', 'and', 'with', 'to', 'shop', 'shops', 'style',
]);

/**
 * Split a query into the kind of place and what qualifies it.
 *
 * "afghan restaurants" → restaurant, qualified by "afghan" (matched against
 * `cuisine` and `name`). Qualifiers are letters only: they are pasted into an
 * Overpass regular expression, and nothing a model writes gets to be syntax.
 */
export function classifyQuery(query: string): { filter?: string; qualifiers: string[] } {
  let rest = ` ${query.toLowerCase()} `;
  let filter: string | undefined;
  for (const c of CATEGORIES) {
    if (c.words.test(rest)) {
      filter = c.filter;
      rest = rest.replace(c.words, ' ');
      break;
    }
  }
  const qualifiers = rest
    .split(/[^\p{L}\p{N}]+/u)
    .map(w => w.trim())
    .filter(w => w.length >= 3 && !FILLER.has(w) && /^[\p{L}\p{N}]+$/u.test(w));
  return { ...(filter ? { filter } : {}), qualifiers };
}

/** The Overpass QL for a category, optionally qualified, around a point. */
export function overpassQuery(filter: string, qualifiers: string[], center: { lat: number; lng: number }, radiusM: number): string {
  const around = `(around:${Math.round(radiusM)},${round(center.lat, 6)},${round(center.lng, 6)})`;
  const clauses: string[] = [];
  if (qualifiers.length === 0) {
    clauses.push(`nwr${filter}${around};`);
  } else {
    const pattern = qualifiers.join('|');
    clauses.push(`nwr${filter}["cuisine"~"${pattern}",i]${around};`);
    clauses.push(`nwr${filter}["name"~"${pattern}",i]${around};`);
  }
  return `[out:json][timeout:25];(${clauses.join('')});out center tags 80;`;
}

/**
 * Ask Overpass, and once more on its public mirror if the main instance is
 * busy. The main instance answers 504/429 under load often enough that one
 * retry elsewhere is the difference between a map and a fallback text search.
 */
async function overpass(query: string): Promise<OverpassElement[]> {
  const ask = (endpoint: string) => overpassSpacer.run(() => requestJson<{ elements?: OverpassElement[] }>(endpoint, {
    what: 'OpenStreetMap nearby search (Overpass)',
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `data=${encodeURIComponent(query)}`,
    timeoutMs: 30_000,
  }));
  try {
    return (await ask(OVERPASS)).elements ?? [];
  } catch (err) {
    const status = err instanceof NetError ? err.status : undefined;
    // Busy or unreachable is worth a second server; a 400 (a bad query) is not.
    if (status !== undefined && status !== 429 && status < 500) throw err;
    return (await ask(OVERPASS_MIRROR)).elements ?? [];
  }
}

function fromOverpass(el: OverpassElement): Place | undefined {
  const lat = el.lat ?? el.center?.lat;
  const lng = el.lon ?? el.center?.lon;
  const tags = el.tags ?? {};
  if (lat === undefined || lng === undefined || !tags.name) return undefined;
  const street = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ');
  const address = [street, tags['addr:suburb'], tags['addr:city']].filter(Boolean).join(', ') || tags['addr:full'];
  const kind = tags.amenity ?? tags.shop ?? tags.tourism ?? tags.leisure;
  return shape({
    name: tags.name,
    ...(kind ? { category: kind.replace(/_/g, ' ') } : {}),
    tags,
    ...(address ? { address } : {}),
    lat,
    lng,
    osmUrl: `https://www.openstreetmap.org/${el.type}/${el.id}`,
  });
}

function shape(input: {
  name: string; category?: string; tags: Record<string, string>; address?: string;
  lat: number; lng: number; osmUrl?: string;
}): Place {
  const t = input.tags;
  const phone = t.phone ?? t['contact:phone'] ?? t['contact:mobile'];
  const website = t.website ?? t['contact:website'] ?? t.url;
  const cuisine = t.cuisine?.replace(/_/g, ' ').replace(/;/g, ', ');
  return {
    name: input.name,
    ...(input.category ? { category: input.category } : {}),
    ...(cuisine ? { cuisine } : {}),
    ...(input.address ? { address: input.address } : {}),
    lat: round(input.lat, 6),
    lng: round(input.lng, 6),
    ...(t.opening_hours ? { openingHours: t.opening_hours } : {}),
    open: null,
    ...(phone ? { phone } : {}),
    ...(website ? { website } : {}),
    ...(input.osmUrl ? { osmUrl: input.osmUrl } : {}),
  };
}

// ── Local time ───────────────────────────────────────────────────────

/**
 * How far the place's clock is from UTC.
 *
 * "Open now" is a question about *their* now. Open-Meteo answers the offset for
 * a coordinate without a key; if it cannot, the longitude gives a rough one,
 * and the result says it is approximate rather than pretending.
 */
async function utcOffsetFor(lat: number, lng: number): Promise<{ offset: number; timezone?: string; approximate?: boolean }> {
  const key = `${round(lat, 1)},${round(lng, 1)}`;
  const cached = offsetCache.get(key);
  if (cached) return cached;
  try {
    const qs = new URLSearchParams({
      latitude: String(round(lat, 4)), longitude: String(round(lng, 4)),
      timezone: 'auto', forecast_days: '1', current: 'is_day',
    });
    const r = await requestJson<{ utc_offset_seconds?: number; timezone?: string }>(`${OPEN_METEO_FORECAST}?${qs}`, {
      what: 'Open-Meteo time zone lookup', timeoutMs: 10_000,
    });
    if (typeof r.utc_offset_seconds === 'number') {
      const found = { offset: r.utc_offset_seconds, ...(r.timezone ? { timezone: r.timezone } : {}) };
      offsetCache.set(key, found);
      return found;
    }
  } catch { /* fall through to the estimate */ }
  return { offset: Math.round(lng / 15) * 3600, approximate: true };
}

// ── The tool ─────────────────────────────────────────────────────────

export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
}

function viewbox(center: { lat: number; lng: number }, radiusKm: number): string {
  const dLat = radiusKm / 111;
  const dLng = radiusKm / (111 * Math.max(0.1, Math.cos(center.lat * Math.PI / 180)));
  return [center.lng - dLng, center.lat + dLat, center.lng + dLng, center.lat - dLat].map(v => round(v, 5)).join(',');
}

function zoomFor(radiusKm: number): number {
  if (radiusKm <= 1) return 15;
  if (radiusKm <= 3) return 14;
  if (radiusKm <= 6) return 13;
  if (radiusKm <= 12) return 12;
  if (radiusKm <= 25) return 11;
  return 10;
}

function dedupe(places: Place[]): Place[] {
  const seen = new Set<string>();
  return places.filter(p => {
    const key = p.osmUrl ?? `${p.name.toLowerCase()}@${round(p.lat, 4)},${round(p.lng, 4)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function places(input: PlacesInput): Promise<string> {
  const query = String(input.query ?? '').trim();
  if (!query) throw new Error('Places needs a query — what kind of place, or its name (e.g. "Afghan restaurant").');
  const limit = Math.max(1, Math.min(30, Math.round(input.limit ?? 10)));
  const hasPoint = typeof input.lat === 'number' && typeof input.lng === 'number'
    && Number.isFinite(input.lat) && Number.isFinite(input.lng);
  if (hasPoint && (Math.abs(input.lat!) > 90 || Math.abs(input.lng!) > 180)) {
    throw new Error('lat must be within ±90 and lng within ±180.');
  }

  let center: Center | undefined;
  if (hasPoint) {
    center = { lat: input.lat!, lng: input.lng!, label: `${round(input.lat!, 4)}, ${round(input.lng!, 4)}` };
  } else if (input.near?.trim()) {
    const found = await geocode(input.near.trim());
    if (!found) {
      throw new Error(`OpenStreetMap has no place called "${input.near}". Try a fuller name ("Abbottabad, Pakistan") or pass lat/lng.`);
    }
    center = found;
  }
  const radiusKm = Math.max(0.2, Math.min(50, input.radiusKm ?? center?.radiusKm ?? 5));

  const cacheKey = JSON.stringify([query.toLowerCase(), center ? [round(center.lat, 4), round(center.lng, 4)] : input.near ?? null, radiusKm, limit]);
  let found = searchCache.get(cacheKey);
  const notes: string[] = [];
  const sources = new Set<string>();

  if (!found) {
    let results: Place[] = [];
    const { filter, qualifiers } = classifyQuery(query);

    // A kind of place near a point: Overpass answers that exactly, including
    // "within this distance", which a text search can only approximate.
    if (center && filter) {
      try {
        const elements = await overpass(overpassQuery(filter, qualifiers, center, radiusKm * 1000));
        results = elements.map(fromOverpass).filter((p): p is Place => Boolean(p));
        if (results.length) sources.add('OpenStreetMap (Overpass)');
      } catch (err) {
        notes.push(`The nearby search (Overpass) failed — ${err instanceof Error ? err.message : String(err)} — so a text search was used instead.`);
      }
    }

    // A name, or a kind Overpass does not know: a text search inside a box
    // around the point, then without the box.
    if (results.length === 0 && center) {
      const hits = await nominatim({ q: query, limit: String(Math.min(40, limit * 2)), viewbox: viewbox(center, radiusKm), bounded: '1' });
      results = hits.map(fromNominatim).filter((p): p is Place => Boolean(p));
      if (results.length) sources.add('OpenStreetMap (Nominatim)');
    }
    if (results.length === 0 && input.near?.trim()) {
      const hits = await nominatim({ q: `${query}, ${input.near.trim()}`, limit: String(Math.min(40, limit * 2)) });
      results = hits.map(fromNominatim).filter((p): p is Place => Boolean(p));
      if (results.length) sources.add('OpenStreetMap (Nominatim)');
    }
    if (results.length === 0 && !center) {
      const hits = await nominatim({ q: query, limit: String(Math.min(40, limit * 2)) });
      results = hits.map(fromNominatim).filter((p): p is Place => Boolean(p));
      if (results.length) sources.add('OpenStreetMap (Nominatim)');
    }

    results = dedupe(results);
    if (center) {
      for (const p of results) p.distanceKm = round(haversineKm(center.lat, center.lng, p.lat, p.lng), 2);
      results.sort((a, b) => (a.distanceKm ?? 0) - (b.distanceKm ?? 0));
    }
    found = results.slice(0, limit);
    searchCache.set(cacheKey, found);
  } else {
    sources.add('OpenStreetMap (cached)');
  }

  const where = input.near?.trim() || center?.label;
  if (found.length === 0) {
    return [
      `No places matching "${query}"${where ? ` near ${where}` : ''} are tagged in OpenStreetMap${center ? ` within ${round(radiusKm, 1)} km` : ''}.`,
      ...notes,
      'OpenStreetMap coverage varies by area. Try a broader query ("restaurant" rather than a cuisine), a larger radiusKm, or WebSearch for listings.',
    ].join('\n');
  }

  // Open now, in the place's own time. One lookup for the area, not per place.
  let approximateClock = false;
  let timezone: string | undefined;
  if (found.some(p => p.openingHours)) {
    const ref = center ?? found[0]!;
    const clock = await utcOffsetFor(ref.lat, ref.lng);
    approximateClock = Boolean(clock.approximate);
    timezone = clock.timezone;
    for (const p of found) p.open = openNow(p.openingHours, clock.offset);
  }

  const lines = found.map((p, i) => {
    const bits = [
      `${i + 1}. ${p.name}`,
      [p.category, p.cuisine ? `cuisine: ${p.cuisine}` : ''].filter(Boolean).join(', '),
      p.address ?? '',
      p.distanceKm !== undefined ? `${p.distanceKm} km away` : '',
      p.openingHours
        ? `hours: ${p.openingHours}${p.open === true ? ' (open now)' : p.open === false ? ' (closed now)' : ' (open-now unknown)'}`
        : 'hours: not tagged',
      p.phone ? `phone: ${p.phone}` : '',
      p.website ? `web: ${p.website}` : '',
      p.osmUrl ? `osm: ${p.osmUrl}` : '',
      `${p.lat},${p.lng}`,
    ].filter(Boolean);
    return bits.join(' · ');
  });

  const block = {
    title: `${query}${where ? ` near ${where.split(',').slice(0, 2).join(',')}` : ''}`,
    ...(center ? { center: [round(center.lat, 5), round(center.lng, 5)], zoom: zoomFor(radiusKm) } : {}),
    places: found.map(p => ({
      name: p.name,
      lat: p.lat,
      lng: p.lng,
      ...(p.category ? { category: p.category } : {}),
      ...(p.address ? { address: p.address } : {}),
      open: p.open,
      ...(p.openingHours ? { hours: p.openingHours } : {}),
      ...(p.phone ? { phone: p.phone } : {}),
      ...(p.website ?? p.osmUrl ? { url: p.website ?? p.osmUrl } : {}),
      ...(p.cuisine ? { note: `Cuisine: ${p.cuisine}` } : {}),
      source: 'OpenStreetMap',
    })),
  };

  return [
    `${found.length} place${found.length === 1 ? '' : 's'} for "${query}"${where ? ` near ${where}` : ''}`
      + `${center ? ` (within ${round(radiusKm, 1)} km)` : ''} — source: ${[...sources].join(', ') || 'OpenStreetMap'}.`,
    ...lines,
    ...notes,
    approximateClock
      ? 'Open-now was judged on a clock estimated from longitude (the time zone lookup failed) — treat it as approximate.'
      : timezone ? `Open-now is judged in local time (${timezone}).` : '',
    '',
    'OpenStreetMap has no ratings, reviews or photos. Add "rating", "reviews" or "image" to a place only from a page you actually read '
      + '(WebSearch/WebFetch), and set that place\'s "source" to where it came from. Never estimate them.',
    'Show these on a map by pasting this block as it is (you may trim places or add a "note"):',
    fencedBlock('places', block),
  ].filter(line => line !== '').join('\n');
}

export const placesDefinition = {
  name: 'Places',
  description:
    'Find real places (restaurants, cafés, hotels, pharmacies, ATMs, landmarks, addresses…) from OpenStreetMap — no key needed. '
    + 'Give a query ("Afghan restaurant", "pharmacy", "Eiffel Tower") and optionally where: `near` (a town or address) or `lat`/`lng`. '
    + 'Returns a compact list (category, cuisine, address, distance, opening hours with open-now in local time, phone, website, OSM link) '
    + 'and a ready-to-paste ```places block that draws them on a map. OSM has no ratings/reviews/photos — never invent them.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to find: a kind of place with qualifiers ("Afghan restaurant", "24h pharmacy") or a name.' },
      near: { type: 'string', description: 'Where to look: a town, district or address ("Abbottabad, Pakistan"). Geocoded first.' },
      lat: { type: 'number', description: 'Latitude of the search centre (use with lng instead of near).' },
      lng: { type: 'number', description: 'Longitude of the search centre.' },
      radiusKm: { type: 'number', description: 'Search radius around the centre, 0.2–50 km. Default: the size of the named area, else 5.' },
      limit: { type: 'number', description: 'Most places to return, 1–30 (default 10).' },
    },
    required: ['query'],
  },
};

