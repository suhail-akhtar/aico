// Shipping quotes for checkout. Called by the cart service and the returns desk.
//
// order = {
//   carrier: 'ups' | 'fedex' | 'dhl' | 'usps',
//   service: 'ground' | 'express' | 'overnight',
//   weightKg: number,
//   dimensionsCm?: { l, w, h },
//   destination: { country: 'US' | ISO code, remote?: boolean },
//   declaredValue?: number,     // USD
//   promoCode?: string,
//   shipDate: 'YYYY-MM-DD',
// }

export function calculateShipping(order) {
  if (!order || typeof order !== 'object') throw new Error('order is required');
  var carrier = String(order.carrier || '').toLowerCase();
  var service = order.service || 'ground';
  var weight = Number(order.weightKg);
  if (!(weight > 0)) throw new Error('weightKg must be positive');
  var intl = !!(order.destination && order.destination.country && order.destination.country !== 'US');
  var remote = !!(order.destination && order.destination.remote);
  var day = new Date(order.shipDate + 'T00:00:00Z').getUTCDay();
  var base = 0, surcharges = 0, discount = 0, eta = 0;
  var notes = [];

  if (carrier === 'ups') {
    if (weight <= 1) base = 8.5;
    else if (weight <= 5) base = 12;
    else if (weight <= 20) base = 25;
    else base = 25 + (weight - 20) * 1.1;
    if (service === 'express') { base = base * 1.8; eta = 2; }
    else if (service === 'overnight') { base = base * 3.2; eta = 1; }
    else { eta = 5; }
    if (order.promoCode === 'UPSGROUND10' && service === 'ground') {
      discount = Math.round(base * 0.1 * 100) / 100;
      notes.push('promo UPSGROUND10');
    }
    if (intl) { surcharges += 15; eta += 3; notes.push('international'); }
    if (remote) { surcharges += 7.5; notes.push('remote area'); }
    if (order.declaredValue > 1000) {
      surcharges += Math.round((order.declaredValue - 1000) * 0.005 * 100) / 100;
      notes.push('insurance');
    }
  } else if (carrier === 'fedex') {
    if (service === 'overnight' && intl) throw new Error('FedEx overnight unavailable for international');
    base = 9 + 1.25 * weight;
    if (service === 'express') { base = base * 1.7; eta = 2; }
    else if (service === 'overnight') { base = base * 2.9; eta = 1; }
    else { eta = 4; }
    var fuel = Math.round(base * 0.065 * 100) / 100;
    surcharges += fuel;
    notes.push('fuel');
    if (day === 6) { surcharges += 12; notes.push('saturday pickup'); }
    if (intl) { surcharges += 18; eta += 4; notes.push('international'); }
    if (remote) { surcharges += 9; eta += 1; notes.push('remote area'); }
    if (order.declaredValue > 1000) {
      surcharges += Math.round((order.declaredValue - 1000) * 0.005 * 100) / 100;
      notes.push('insurance');
    }
  } else if (carrier === 'dhl') {
    var billable = weight;
    if (order.dimensionsCm) {
      var vol = (order.dimensionsCm.l * order.dimensionsCm.w * order.dimensionsCm.h) / 5000;
      if (vol > billable) { billable = vol; notes.push('volumetric'); }
    }
    base = 14 + 2.1 * billable;
    if (service === 'ground') { base = base * 0.8; eta = 6; notes.push('economy'); }
    else if (service === 'overnight') { base = base * 2.4; eta = 1; }
    else { eta = 3; }
    if (!intl) { surcharges += 5; notes.push('domestic handling'); }
    else { eta += 2; }
    if (remote) { surcharges += 11; eta += 2; notes.push('remote area'); }
    if (order.declaredValue > 100) {
      surcharges += Math.round((order.declaredValue - 100) * 0.01 * 100) / 100;
      notes.push('insurance');
    }
  } else if (carrier === 'usps') {
    if (intl) throw new Error('USPS: international not supported');
    if (weight <= 2) {
      base = service === 'overnight' ? 26.35 : 7.95;
      notes.push('flat rate');
    } else {
      base = 5 + 0.9 * weight;
      if (service === 'express') base = base * 1.5;
      else if (service === 'overnight') base = base * 2.6;
    }
    eta = service === 'overnight' ? 1 : service === 'express' ? 3 : 6;
    if (remote) { eta += 2; notes.push('remote area'); }
    if (order.declaredValue > 1000) {
      surcharges += Math.round((order.declaredValue - 1000) * 0.005 * 100) / 100;
      notes.push('insurance');
    }
    if (order.promoCode === 'FREESHIP' && service === 'ground') {
      discount = base + surcharges;
      notes.push('promo FREESHIP');
    }
  } else {
    throw new Error('Unsupported carrier: ' + order.carrier);
  }

  base = Math.round(base * 100) / 100;
  surcharges = Math.round(surcharges * 100) / 100;
  var cost = Math.round((base + surcharges - discount) * 100) / 100;
  if (cost < 0) cost = 0;
  return {
    carrier: carrier,
    service: service,
    cost: cost,
    currency: 'USD',
    breakdown: { base: base, surcharges: surcharges, discount: discount },
    etaDays: eta,
    notes: notes,
  };
}
