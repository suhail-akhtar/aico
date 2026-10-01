// Rules every carrier shares: input normalisation, insurance and final rounding.

export function normalise(order) {
  if (!order || typeof order !== 'object') throw new Error('order is required');
  const weight = Number(order.weightKg);
  if (!(weight > 0)) throw new Error('weightKg must be positive');
  return {
    carrier: String(order.carrier || '').toLowerCase(),
    service: order.service || 'ground',
    weight,
    intl: !!(order.destination && order.destination.country && order.destination.country !== 'US'),
    remote: !!(order.destination && order.destination.remote),
    day: new Date(order.shipDate + 'T00:00:00Z').getUTCDay(),
  };
}

const round2 = (x) => Math.round(x * 100) / 100;

/** Declared-value insurance above a threshold. */
export function insurance(declaredValue, { over = 1000, rate = 0.005 } = {}) {
  return declaredValue > over ? round2((declaredValue - over) * rate) : 0;
}

export function finalize(ctx, { base, surcharges, discount, eta, notes }) {
  const b = round2(base);
  const s = round2(surcharges);
  let cost = round2(b + s - discount);
  if (cost < 0) cost = 0;
  return {
    carrier: ctx.carrier,
    service: ctx.service,
    cost,
    currency: 'USD',
    breakdown: { base: b, surcharges: s, discount },
    etaDays: eta,
    notes,
  };
}
