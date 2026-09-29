/**
 * `Weather` — current conditions and a forecast from Open-Meteo, ready for a
 * ```weather card.
 *
 * Keyless, and in the place's own time zone (`timezone=auto`), so "tomorrow"
 * and "3 pm" mean what the person there would mean. Weather conditions travel
 * as WMO codes, untranslated: the card has its own icons for them, and a
 * description invented here would be a second vocabulary to keep in step.
 *
 * @module tools/weather
 */

import { requestJson, TtlCache, fencedBlock, round } from './net.js';

export interface WeatherInput {
  location?: string;
  lat?: number;
  lng?: number;
  days?: number;
  units?: 'metric' | 'imperial';
}

const GEOCODE = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST = 'https://api.open-meteo.com/v1/forecast';

const geocodeCache = new TtlCache<GeoHit | null>(60 * 60 * 1000);
const forecastCache = new TtlCache<Forecast>(10 * 60 * 1000);

export function resetWeatherForTests(): void {
  geocodeCache.clear();
  forecastCache.clear();
}

interface GeoHit {
  name: string;
  latitude: number;
  longitude: number;
  country?: string;
  country_code?: string;
  admin1?: string;
  timezone?: string;
}

interface Forecast {
  timezone?: string;
  current?: Record<string, number | string>;
  hourly?: Record<string, Array<number | string | null>>;
  daily?: Record<string, Array<number | string | null>>;
}

/** WMO weather interpretation codes, as Open-Meteo documents them. */
export const WMO_CODES: Record<number, string> = {
  0: 'clear sky', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast',
  45: 'fog', 48: 'depositing rime fog',
  51: 'light drizzle', 53: 'drizzle', 55: 'dense drizzle', 56: 'light freezing drizzle', 57: 'freezing drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain', 66: 'light freezing rain', 67: 'freezing rain',
  71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains',
  80: 'light showers', 81: 'showers', 82: 'violent showers', 85: 'light snow showers', 86: 'snow showers',
  95: 'thunderstorm', 96: 'thunderstorm with light hail', 99: 'thunderstorm with heavy hail',
};

export function describeWmo(code: number): string {
  return WMO_CODES[code] ?? `weather code ${code}`;
}

async function geocode(text: string): Promise<GeoHit | null> {
  const key = text.trim().toLowerCase();
  const cached = geocodeCache.get(key);
  if (cached !== undefined) return cached;

  const search = async (name: string): Promise<GeoHit[]> => {
    const qs = new URLSearchParams({ name, count: '10', language: 'en', format: 'json' });
    const r = await requestJson<{ results?: GeoHit[] }>(`${GEOCODE}?${qs}`, { what: 'Open-Meteo geocoding' });
    return r.results ?? [];
  };

  // Open-Meteo's geocoder matches a place *name*, so "Abbottabad, Pakistan"
  // finds nothing. Search the name, then prefer the hit whose country or
  // region matches whatever followed the comma.
  const [head, ...rest] = text.split(',').map(s => s.trim()).filter(Boolean);
  let hits = await search(text.trim());
  if (hits.length === 0 && head && rest.length) hits = await search(head);
  let hit: GeoHit | undefined = hits[0];
  if (rest.length && hits.length > 1) {
    const want = rest.join(' ').toLowerCase();
    hit = hits.find(h => [h.country, h.country_code, h.admin1].some(v => v && want.includes(v.toLowerCase()))) ?? hit;
  }
  const result = hit ?? null;
  geocodeCache.set(key, result);
  return result;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export async function weather(input: WeatherInput): Promise<string> {
  const days = Math.max(1, Math.min(16, Math.round(input.days ?? 7)));
  const units = input.units === 'imperial' ? 'imperial' : 'metric';
  const hasPoint = typeof input.lat === 'number' && typeof input.lng === 'number'
    && Number.isFinite(input.lat) && Number.isFinite(input.lng);

  let lat: number;
  let lng: number;
  let label: string;
  if (hasPoint) {
    if (Math.abs(input.lat!) > 90 || Math.abs(input.lng!) > 180) throw new Error('lat must be within ±90 and lng within ±180.');
    lat = input.lat!;
    lng = input.lng!;
    label = input.location?.trim() || `${round(lat, 3)}, ${round(lng, 3)}`;
  } else if (input.location?.trim()) {
    const hit = await geocode(input.location);
    if (!hit) {
      throw new Error(`Open-Meteo could not find "${input.location}". Try the town's name on its own, or pass lat/lng.`);
    }
    lat = hit.latitude;
    lng = hit.longitude;
    label = [hit.name, hit.admin1 && hit.admin1 !== hit.name ? hit.admin1 : '', hit.country].filter(Boolean).join(', ');
  } else {
    throw new Error('Weather needs a location (a town name) or lat/lng.');
  }

  const qs = new URLSearchParams({
    latitude: String(round(lat, 4)),
    longitude: String(round(lng, 4)),
    timezone: 'auto',
    forecast_days: String(Math.max(days, 2)),
    current: 'temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code,is_day',
    hourly: 'temperature_2m,weather_code,precipitation_probability',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset',
    ...(units === 'imperial'
      ? { temperature_unit: 'fahrenheit', wind_speed_unit: 'mph', precipitation_unit: 'inch' }
      : { wind_speed_unit: 'kmh' }),
  });
  const url = `${FORECAST}?${qs}`;
  let data = forecastCache.get(url);
  if (!data) {
    data = await requestJson<Forecast>(url, { what: 'Open-Meteo forecast' });
    forecastCache.set(url, data);
  }

  const c = data.current ?? {};
  const code = num(c.weather_code) ?? 0;
  const current = {
    time: String(c.time ?? ''),
    temp: round(num(c.temperature_2m) ?? NaN, 1),
    feels: round(num(c.apparent_temperature) ?? NaN, 1),
    humidity: Math.round(num(c.relative_humidity_2m) ?? NaN),
    wind: round(num(c.wind_speed_10m) ?? NaN, 1),
    code,
    ...(num(c.is_day) !== undefined ? { isDay: c.is_day === 1 } : {}),
  };

  // The next 24 hours from the current hour, in local time. Open-Meteo's
  // hourly series starts at local midnight, so it is sliced rather than taken.
  const h = data.hourly ?? {};
  const times = (h.time ?? []) as string[];
  const nowHour = current.time.slice(0, 13);
  let start = times.findIndex(t => t.slice(0, 13) >= nowHour);
  if (start < 0) start = 0;
  const hourly = times.slice(start, start + 24).map((time, k) => {
    const i = start + k;
    const precip = num(h.precipitation_probability?.[i]);
    return {
      time,
      temp: round(num(h.temperature_2m?.[i]) ?? NaN, 1),
      code: num(h.weather_code?.[i]) ?? 0,
      ...(precip !== undefined ? { precip } : {}),
    };
  });

  const d = data.daily ?? {};
  const daily = ((d.time ?? []) as string[]).slice(0, days).map((date, i) => {
    const precip = num(d.precipitation_probability_max?.[i]);
    const sunrise = d.sunrise?.[i];
    const sunset = d.sunset?.[i];
    return {
      date,
      min: round(num(d.temperature_2m_min?.[i]) ?? NaN, 1),
      max: round(num(d.temperature_2m_max?.[i]) ?? NaN, 1),
      code: num(d.weather_code?.[i]) ?? 0,
      ...(precip !== undefined ? { precip } : {}),
      ...(typeof sunrise === 'string' ? { sunrise } : {}),
      ...(typeof sunset === 'string' ? { sunset } : {}),
    };
  });

  const t = units === 'imperial' ? '°F' : '°C';
  const w = units === 'imperial' ? 'mph' : 'km/h';
  const block = {
    location: label,
    lat: round(lat, 4),
    lng: round(lng, 4),
    ...(data.timezone ? { timezone: data.timezone } : {}),
    units,
    current,
    hourly,
    daily,
    source: 'Open-Meteo',
  };

  const dayLines = daily.map(day =>
    `${day.date}: ${describeWmo(day.code)}, ${day.min}–${day.max}${t}`
    + `${day.precip !== undefined ? `, ${day.precip}% chance of precipitation` : ''}`);

  return [
    `Weather for ${label} (${data.timezone ?? 'local time'}), from Open-Meteo:`,
    `Now (${current.time}): ${describeWmo(code)}, ${current.temp}${t} (feels like ${current.feels}${t}), `
      + `humidity ${current.humidity}%, wind ${current.wind} ${w}.`,
    ...dayLines,
    'Precipitation figures ("precip") are the probability in percent. Codes are WMO weather codes.',
    'Show it as a card by pasting this block as it is:',
    fencedBlock('weather', block),
  ].join('\n');
}

export const weatherDefinition = {
  name: 'Weather',
  description:
    'Current weather and a forecast (1–16 days) for a place, from Open-Meteo — no key needed. '
    + 'Give `location` (a town name) or `lat`/`lng`. Times are in the place\'s local time zone. '
    + 'Returns a short summary and a ready-to-paste ```weather block that draws a forecast card '
    + '(current conditions, next 24 hours, daily highs/lows, WMO weather codes).',
  inputSchema: {
    type: 'object',
    properties: {
      location: { type: 'string', description: 'Town or city ("Abbottabad", "Lahore, Pakistan").' },
      lat: { type: 'number', description: 'Latitude, instead of location.' },
      lng: { type: 'number', description: 'Longitude, instead of location.' },
      days: { type: 'number', description: 'Days of forecast, 1–16 (default 7).' },
      units: { type: 'string', enum: ['metric', 'imperial'], description: 'metric (°C, km/h — default) or imperial (°F, mph).' },
    },
  },
};
