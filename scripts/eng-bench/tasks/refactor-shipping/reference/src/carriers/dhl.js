import { normalise, insurance, finalize } from './shared.js';

export default {
  name: 'dhl',
  quote(order, ctx = normalise(order)) {
    const { weight, service, intl, remote } = ctx;
    const notes = [];
    let billable = weight;
    if (order.dimensionsCm) {
      const vol = (order.dimensionsCm.l * order.dimensionsCm.w * order.dimensionsCm.h) / 5000;
      if (vol > billable) { billable = vol; notes.push('volumetric'); }
    }
    let base = 14 + 2.1 * billable, eta, surcharges = 0;
    if (service === 'ground') { base = base * 0.8; eta = 6; notes.push('economy'); }
    else if (service === 'overnight') { base = base * 2.4; eta = 1; }
    else eta = 3;
    if (!intl) { surcharges += 5; notes.push('domestic handling'); }
    else eta += 2;
    if (remote) { surcharges += 11; eta += 2; notes.push('remote area'); }
    if (order.declaredValue > 100) { surcharges += insurance(order.declaredValue, { over: 100, rate: 0.01 }); notes.push('insurance'); }
    return finalize(ctx, { base, surcharges, discount: 0, eta, notes });
  },
};
