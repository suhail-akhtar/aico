import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import en from './en.json';
import {
  detectLocale,
  formatDateTime,
  formatNumber,
  getLocale,
  type MessageKey,
  setLocale,
  t,
  tn,
} from './i18n';

describe('t and tn', () => {
  it('interpolates named parameters and leaves unknown ones visible', () => {
    expect(t('delete.body', { name: 'Pen' })).toBe('Pen will be removed. This cannot be undone.');
    expect(t('delete.body')).toBe('{name} will be removed. This cannot be undone.');
  });

  it('chooses the plural form for the locale and formats the count', () => {
    expect(tn('items.count', 1)).toBe('1 item');
    expect(tn('items.count', 0)).toBe('0 items');
    expect(tn('items.count', 1234)).toBe('1,234 items');
  });
});

describe('locale', () => {
  it('detects the first supported language and falls back to English', () => {
    expect(detectLocale(['fr-CA', 'en-GB'])).toBe('en');
    expect(detectLocale(['de'])).toBe('en');
    expect(detectLocale([])).toBe('en');
  });

  it('sets the document language and ignores an unknown locale', () => {
    setLocale('en');
    expect(document.documentElement.lang).toBe('en');
    setLocale('xx');
    expect(getLocale()).toBe('en');
  });

  it('formats numbers and dates through Intl, tolerating a bad date', () => {
    expect(formatNumber(1234567)).toBe('1,234,567');
    expect(formatDateTime('2026-10-06T10:30:00Z')).toMatch(/2026/);
    expect(formatDateTime('not a date')).toBe('not a date');
  });
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (name === 'generated' || name === 'test') return [];
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\./.test(name) ? [full] : [];
  });
}

describe('the message catalogue', () => {
  const root = path.resolve(import.meta.dirname, '..', '..');
  const used = new Set<string>();
  for (const file of sourceFiles(root)) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/\bt\(\s*'([a-zA-Z0-9.]+)'/g)) used.add(m[1] as string);
    for (const m of text.matchAll(/\btn\(\s*'([a-zA-Z0-9.]+)'/g)) {
      used.add(`${m[1]}.one`);
      used.add(`${m[1]}.other`);
    }
  }

  it('has every key the source uses', () => {
    const missing = [...used].filter((key) => !(key in en));
    expect(missing).toEqual([]);
  });

  it('has no key nothing uses (dead copy rots)', () => {
    const unused = (Object.keys(en) as MessageKey[]).filter((key) => !used.has(key));
    expect(unused).toEqual([]);
  });
});
