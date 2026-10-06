/**
 * A small typed message catalogue: enough to make the app translatable without
 * adding a dependency before there is a second language.
 *
 * Every user-visible string is a key in `en.json`; `t` is checked at
 * compile time, so a typo or a deleted message fails `npm run typecheck`, and a
 * unit test fails on a key that is unused or missing from a locale. Plurals use
 * `Intl.PluralRules` through the `.one` / `.other` suffix convention, and dates
 * and numbers go through `Intl` for the active locale.
 *
 * To add a language: copy `en.json` to `fr.json`, translate it, register it in
 * `catalogs` below. When the need outgrows this (ICU messages, lazy loading
 * per locale, translators' tooling), swap this module for i18next or Lingui:
 * call sites only use `t`, `tn` and the two format helpers.
 */

import en from './en.json';

export type MessageKey = keyof typeof en;
type Params = Record<string, string | number>;
type PluralBases<K> = K extends `${infer B}.other` ? B : never;
type PluralBase = PluralBases<MessageKey>;

const catalogs: Record<string, Partial<Record<MessageKey, string>>> = { en };
let locale = 'en';

/** The first of the browser's preferred languages that has a catalogue, else English. */
export function detectLocale(preferred: readonly string[] = navigator.languages ?? []): string {
  for (const tag of preferred) {
    const base = tag.toLowerCase().split('-')[0] ?? '';
    if (base in catalogs) return base;
  }
  return 'en';
}

export function setLocale(next: string): void {
  locale = next in catalogs ? next : 'en';
  if (typeof document !== 'undefined') document.documentElement.lang = locale;
}

export function getLocale(): string {
  return locale;
}

function interpolate(template: string, params?: Params): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in params ? String(params[name]) : whole,
  );
}

export function t(key: MessageKey, params?: Params): string {
  return interpolate(catalogs[locale]?.[key] ?? en[key], params);
}

/** `tn('items.count', 3)` picks `items.count.one` or `items.count.other` for the locale. */
export function tn(base: PluralBase, count: number, params?: Params): string {
  const form = new Intl.PluralRules(locale).select(count);
  const key = `${base}.${form}` as MessageKey;
  const chosen = key in en ? key : (`${base}.other` as MessageKey);
  return t(chosen, { count: new Intl.NumberFormat(locale).format(count), ...params });
}

export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat(locale).format(value);
}
