// Reference refactor (grader self-test only).
import ups from './carriers/ups.js';
import fedex from './carriers/fedex.js';
import dhl from './carriers/dhl.js';
import usps from './carriers/usps.js';
import { normalise } from './carriers/shared.js';

const registry = new Map();

export function registerCarrier(name, strategy) {
  if (!strategy || typeof strategy.quote !== 'function') throw new Error('strategy must have quote(order)');
  registry.set(String(name).toLowerCase(), strategy);
}

[ups, fedex, dhl, usps].forEach((s) => registerCarrier(s.name, s));

export function calculateShipping(order) {
  const ctx = normalise(order);
  const strategy = registry.get(ctx.carrier);
  if (!strategy) throw new Error('Unsupported carrier: ' + order.carrier);
  return strategy.quote(order, ctx);
}
