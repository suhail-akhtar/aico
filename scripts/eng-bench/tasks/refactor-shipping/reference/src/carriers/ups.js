import { normalise, insurance, finalize } from './shared.js';

export default {
  name: 'ups',
  quote(order, ctx = normalise(order)) {
    const { weight, service, intl, remote } = ctx;
    let base, eta, surcharges = 0, discount = 0;
    const notes = [];
    if (weight <= 1) base = 8.5;
    else if (weight <= 5) base = 12;
    else if (weight <= 20) base = 25;
    else base = 25 + (weight - 20) * 1.1;
    if (service === 'express') { base = base * 1.8; eta = 2; }
    else if (service === 'overnight') { base = base * 3.2; eta = 1; }
    else eta = 5;
    if (order.promoCode === 'UPSGROUND10' && service === 'ground') {
      discount = Math.round(base * 0.1 * 100) / 100;
      notes.push('promo UPSGROUND10');
    }
    if (intl) { surcharges += 15; eta += 3; notes.push('international'); }
    if (remote) { surcharges += 7.5; notes.push('remote area'); }
    const ins = insurance(order.declaredValue);
    if (order.declaredValue > 1000) { surcharges += ins; notes.push('insurance'); }
    return finalize(ctx, { base, surcharges, discount, eta, notes });
  },
};
