// Hidden acceptance tests for the shipping refactor. Copied into the project
// (with the pre-refactor module as ./original-shipping.mjs) only after the
// agent's turn has ended.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as refactored from '../src/shipping.js';
import { calculateShipping as original } from './original-shipping.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..', 'src');

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
}
const pick = (r, xs) => xs[Math.floor(r() * xs.length)];

function orders(n, seed) {
  const r = rng(seed);
  const out = [null, { carrier: 'pigeon', weightKg: 0 }, { carrier: 'ups', weightKg: -2, shipDate: '2024-01-01' }];
  for (let i = 0; i < n; i++) {
    const o = {
      carrier: pick(r, ['ups', 'fedex', 'dhl', 'usps', 'ups', 'fedex', 'dhl', 'usps', 'UPS', 'FedEx', 'pigeon', '']),
      service: pick(r, ['ground', 'express', 'overnight', undefined]),
      weightKg: pick(r, [0.4, 1, 1.7, 2, 2.01, 3.3, 5, 7.25, 19.9, 20, 23.5, 41, 0]),
      destination: pick(r, [{ country: 'US' }, { country: 'US', remote: true }, { country: 'DE' }, { country: 'CA', remote: true }, {}, undefined]),
      shipDate: `2024-${String(1 + Math.floor(r() * 12)).padStart(2, '0')}-${String(1 + Math.floor(r() * 28)).padStart(2, '0')}`,
    };
    if (r() < 0.5) o.declaredValue = pick(r, [50, 100, 101, 150, 999, 1000, 1000.5, 2500, 12000]);
    if (r() < 0.35) o.promoCode = pick(r, ['UPSGROUND10', 'FREESHIP', 'BOGUS']);
    if (r() < 0.3) o.dimensionsCm = { l: pick(r, [10, 30, 60]), w: pick(r, [10, 40]), h: pick(r, [5, 30, 55]) };
    out.push(o);
  }
  return out;
}

function outcome(fn, order) {
  try { return { ok: fn(structuredClone(order)) }; } catch (e) { return { error: String(e?.message ?? e) }; }
}

test('hidden: behaviour is identical to the original for 800 generated orders', () => {
  const mismatches = [];
  for (const o of orders(800, 20261001)) {
    const a = outcome(original, o);
    const b = outcome(refactored.calculateShipping, o);
    try { assert.deepStrictEqual(b, a); } catch { mismatches.push({ order: o, expected: a, got: b }); }
  }
  assert.equal(mismatches.length, 0, `${mismatches.length} mismatches, e.g. ${JSON.stringify(mismatches.slice(0, 2))}`);
});

test('hidden: registerCarrier adds a carrier without editing calculateShipping', () => {
  assert.equal(typeof refactored.registerCarrier, 'function', 'registerCarrier is not exported');
  const quote = { carrier: 'acme', service: 'ground', cost: 1.23, currency: 'USD', breakdown: { base: 1.23, surcharges: 0, discount: 0 }, etaDays: 9, notes: ['acme'] };
  refactored.registerCarrier('acme', { quote: () => structuredClone(quote) });
  const got = refactored.calculateShipping({ carrier: 'acme', service: 'ground', weightKg: 2, destination: { country: 'US' }, shipDate: '2024-05-05' });
  assert.deepStrictEqual(got, quote);
});

test('hidden: calculateShipping is a thin dispatcher with no carrier logic', () => {
  const text = refactored.calculateShipping.toString();
  const lines = text.split('\n').filter((l) => l.trim()).length;
  assert.ok(lines <= 30, `calculateShipping is ${lines} lines`);
  assert.ok(!/\b(ups|fedex|dhl|usps)\b/i.test(text), 'calculateShipping still names a carrier');
});

test('hidden: one strategy module with quote() per carrier under src/carriers', async () => {
  const dir = path.join(src, 'carriers');
  assert.ok(fs.existsSync(dir), 'src/carriers does not exist');
  const files = fs.readdirSync(dir).filter((f) => /\.m?js$/.test(f));
  for (const carrier of ['ups', 'fedex', 'dhl', 'usps']) {
    const file = files.find((f) => f.toLowerCase().includes(carrier));
    assert.ok(file, `no module for ${carrier} in src/carriers (${files.join(', ')})`);
    const mod = await import(pathToFileURL(path.join(dir, file)).href);
    const exported = Object.values(mod);
    const hasQuote = exported.some((v) => v && (typeof v.quote === 'function' || typeof v.prototype?.quote === 'function'))
      || typeof mod.quote === 'function';
    assert.ok(hasQuote, `${file} exports no strategy with quote()`);
  }
});

test('hidden: shared insurance rule is not copied per carrier', () => {
  const all = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.m?js$/.test(e.name)) all.push(fs.readFileSync(p, 'utf8')); } };
  walk(src);
  // Count the insurance *formula* — `(value - threshold) * rate` in either
  // operand order — not the rate literal: passing each carrier's rate to one
  // shared helper is a fine design and repeats `0.005` as an argument. The
  // only other formula of that shape is the UPS per-kg overweight charge.
  const code = all.join('\n');
  const formulas = [
    ...(code.match(/\(\s*[\w.]+\s*-\s*[\w.]+\s*\)\s*\*\s*[\w.]+/g) ?? []),
    ...(code.match(/[\w.]+\s*\*\s*\(\s*[\w.]+\s*-\s*[\w.]+\s*\)/g) ?? []),
  ].filter((f) => !/weight|kg|billable|\b20\b|1\.1\b/i.test(f));
  assert.ok(formulas.length <= 1, `the insurance formula is written ${formulas.length} times in src/: ${formulas.join(' | ')}`);
});
