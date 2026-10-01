import { normalise, insurance, finalize } from './shared.js';

export default {
  name: 'usps',
  quote(order, ctx = normalise(order)) {
    const { weight, service, intl, remote } = ctx;
    if (intl) throw new Error('USPS: international not supported');
    const notes = [];
    let base, surcharges = 0, discount = 0;
    if (weight <= 2) {
      base = service === 'overnight' ? 26.35 : 7.95;
      notes.push('flat rate');
    } else {
      base = 5 + 0.9 * weight;
      if (service === 'express') base = base * 1.5;
      else if (service === 'overnight') base = base * 2.6;
    }
    let eta = service === 'overnight' ? 1 : service === 'express' ? 3 : 6;
    if (remote) { eta += 2; notes.push('remote area'); }
    if (order.declaredValue > 1000) { surcharges += insurance(order.declaredValue); notes.push('insurance'); }
    if (order.promoCode === 'FREESHIP' && service === 'ground') {
      discount = base + surcharges;
      notes.push('promo FREESHIP');
    }
    return finalize(ctx, { base, surcharges, discount, eta, notes });
  },
};
