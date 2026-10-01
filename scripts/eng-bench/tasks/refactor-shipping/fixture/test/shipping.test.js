import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateShipping } from '../src/shipping.js';

const base = { weightKg: 3, destination: { country: 'US' }, shipDate: '2024-03-12' };

test('ups ground domestic', () => {
  const q = calculateShipping({ ...base, carrier: 'ups', service: 'ground' });
  assert.equal(q.cost, 12);
  assert.equal(q.etaDays, 5);
  assert.equal(q.currency, 'USD');
});

test('ups ground promo takes 10% off the base', () => {
  const q = calculateShipping({ ...base, carrier: 'ups', service: 'ground', promoCode: 'UPSGROUND10' });
  assert.equal(q.cost, 10.8);
  assert.equal(q.breakdown.discount, 1.2);
});

test('fedex express adds fuel', () => {
  const q = calculateShipping({ ...base, carrier: 'fedex', service: 'express' });
  assert.equal(q.breakdown.base, 21.68);
  assert.equal(q.cost, 23.09);
});

test('fedex refuses international overnight', () => {
  assert.throws(() => calculateShipping({ ...base, carrier: 'fedex', service: 'overnight', destination: { country: 'DE' } }), /unavailable/);
});

test('dhl domestic handling and volumetric weight', () => {
  const q = calculateShipping({ ...base, carrier: 'dhl', service: 'express', dimensionsCm: { l: 50, w: 40, h: 30 } });
  assert.ok(q.notes.includes('volumetric'));
  assert.equal(q.cost, 44.2);
});

test('usps flat rate under 2kg', () => {
  const q = calculateShipping({ ...base, weightKg: 1.5, carrier: 'usps', service: 'express' });
  assert.equal(q.cost, 7.95);
});

test('usps FREESHIP makes ground free', () => {
  const q = calculateShipping({ ...base, carrier: 'usps', service: 'ground', promoCode: 'FREESHIP' });
  assert.equal(q.cost, 0);
});

test('unknown carrier', () => {
  assert.throws(() => calculateShipping({ ...base, carrier: 'pigeon' }), /Unsupported carrier: pigeon/);
});
