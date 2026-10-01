import { normalise, insurance, finalize } from './shared.js';

export default {
  name: 'fedex',
  quote(order, ctx = normalise(order)) {
    const { weight, service, intl, remote, day } = ctx;
    if (service === 'overnight' && intl) throw new Error('FedEx overnight unavailable for international');
    let base = 9 + 1.25 * weight, eta, surcharges = 0;
    const notes = [];
    if (service === 'express') { base = base * 1.7; eta = 2; }
    else if (service === 'overnight') { base = base * 2.9; eta = 1; }
    else eta = 4;
    surcharges += Math.round(base * 0.065 * 100) / 100;
    notes.push('fuel');
    if (day === 6) { surcharges += 12; notes.push('saturday pickup'); }
    if (intl) { surcharges += 18; eta += 4; notes.push('international'); }
    if (remote) { surcharges += 9; eta += 1; notes.push('remote area'); }
    if (order.declaredValue > 1000) { surcharges += insurance(order.declaredValue); notes.push('insurance'); }
    return finalize(ctx, { base, surcharges, discount: 0, eta, notes });
  },
};
