/**
 * Generates the cochange-fix task's repository: a JavaScript invoicing
 * service (~115 files) *with a git history* (~110 commits, fixed dates), in
 * which every commit that touched the tax-rates table (src/tax/rates.js, "A")
 * also touched the e-invoice ledger-partition table (src/edi/partitions.js,
 * "B") — and nothing in the code links the two.
 *
 * Why it is shaped like this: the task adds a tax region (Nunavut). The
 * obvious file is A, and a change to A alone passes the visible tests; the
 * hidden test renders an e-invoice for NU, which goes through B. A imports
 * nothing from B and B nothing from A, the e-invoice writer takes the tax
 * amount precomputed, and B shares no vocabulary with A ("partition", not
 * "tax"/"rate"). The relation lives only in the history — the signal a
 * co-change edge (buruj-code-lens) is meant to surface and an import/call
 * graph (graphify) cannot. Region lists that must NOT gain NU (shipping
 * zones, holiday calendars, marketing copy, phone area codes) are decoys for a
 * text search.
 *
 * Deterministic: fixed lists, a seeded LCG for the noise commits, and fixed
 * author/committer dates, so the commit ids are identical on every run.
 */
import { GITIGNORE, lcg, pick } from '../../lib/generated.mjs';

/** Region order = the order they were added (and their partition numbers). */
const REGIONS = [['ON', 0.13], ['QC', 0.14975], ['BC', 0.12], ['AB', 0.05], ['MB', 0.12], ['SK', 0.11], ['NS', 0.14], ['NB', 0.15], ['NL', 0.15], ['PE', 0.15], ['YT', 0.05], ['NT', 0.05]];
const INITIAL = 7;
const DECOY_LISTS = {
  'src/shipping/zones.js': (rs) => `/** Shipping zone per region (ground carriers). Northern territories ship by air: zone 9. */\nexport const ZONES = {\n${rs.map(([r], i) => `  ${r}: ${['YT', 'NT'].includes(r) ? 9 : (i % 4) + 1},`).join('\n')}\n};\n\nexport function zoneFor(region) {\n  const z = ZONES[region];\n  if (z === undefined) throw new Error(\`We do not ship to \${region}\`);\n  return z;\n}\n`,
  'src/calendar/holidays.js': (rs) => `/** Regional statutory holidays observed by support (month-day). */\nexport const HOLIDAYS = {\n${rs.map(([r], i) => `  ${r}: ['01-01', '07-01', '${String((i % 9) + 2).padStart(2, '0')}-1${i % 10}'],`).join('\n')}\n};\n`,
  'src/marketing/regionCopy.js': (rs) => `/** Landing-page taglines per region. */\nexport const COPY = {\n${rs.map(([r]) => `  ${r}: 'Fast invoicing for ${r} businesses',`).join('\n')}\n};\n`,
  'src/phone/areaCodes.js': (rs) => `/** A sample area code per region, for phone-number hints. */\nexport const AREA_CODES = {\n${rs.map(([r], i) => `  ${r}: '${200 + i * 37}',`).join('\n')}\n};\n`,
};

function ratesFile(regions) {
  return `/** Combined sales-tax rate (GST/HST, plus PST/QST where applicable) per province or territory. */
export const RATES = {
${regions.map(([r, x]) => `  ${r}: ${x},`).join('\n')}
};

/** Regions that can be selected at checkout. */
export const REGIONS = Object.keys(RATES);

/** Tax in cents for an amount in cents, rounded half up. */
export function computeTax(region, cents) {
  const rate = RATES[region];
  if (rate === undefined) throw new Error(\`Unsupported region: \${region}\`);
  return Math.round(cents * rate);
}
`;
}

function partitionsFile(regions, reviewed) {
  return `/**
 * Ledger partitions for the e-invoice writer: the CRA gateway files each
 * e-invoice under the partition of the customer's province or territory.
 * Numbers are permanent: never reuse or renumber; append a new code at the end
 * with the next number. Last reviewed: ${reviewed}.
 */
const TABLE = [
${regions.map(([r], i) => `  ['${r}', 'LP-${String(i + 1).padStart(2, '0')}'],`).join('\n')}
];

const BY_CODE = new Map(TABLE);

export function partitionFor(code) {
  const p = BY_CODE.get(code);
  if (!p) throw new Error(\`No ledger partition for \${code}\`);
  return p;
}
`;
}

/** Noise modules: each grows one helper per commit; the fixture holds the final version. */
const NOISE_AREAS = ['util', 'customers', 'reports', 'ui', 'billing'];
const NOISE_NOUNS = ['email', 'phone', 'address', 'postcode', 'currency', 'percent', 'dates', 'slug', 'csv', 'pager', 'sort', 'group', 'search', 'cache', 'retry', 'clock', 'ids', 'locale', 'json', 'mask', 'trim', 'chunk'];
function noiseFile(area, noun, n) {
  const fns = [];
  for (let i = 1; i <= n; i++) fns.push(`/** ${noun} helper ${i} (${area}). */\nexport function ${noun}${area[0].toUpperCase()}${area.slice(1)}${i}(value) {\n  return String(value ?? '').trim() + '${'#'.repeat(i)}';\n}\n`);
  return fns.join('\n');
}

/**
 * The repository: `files` is the final state (the fixture or the reference),
 * `history` the commits that lead to the fixture, `meta` what the grader needs.
 */
export function generate(variant = 'fixture') {
  const ref = variant === 'reference';
  const rand = lcg(20261008);
  const files = new Map();
  const set = (rel, text) => files.set(rel, text);
  const finalRegions = ref ? [...REGIONS, ['NU', 0.05]] : REGIONS;

  set('.gitignore', GITIGNORE);
  set('package.json', `${JSON.stringify({ name: 'ledgerly', version: '4.1.0', private: true, type: 'module', scripts: { test: 'node --test "test/*.test.js"' } }, null, 2)}\n`);
  set('README.md', '# ledgerly\n\nInvoicing for Canadian small businesses: checkout quotes, invoices, CRA e-invoices.\n\n`npm test`.\n');
  set('src/tax/rates.js', ratesFile(finalRegions));
  set('src/edi/partitions.js', partitionsFile(finalRegions, '2026-05-18'));
  for (const [rel, fn] of Object.entries(DECOY_LISTS)) set(rel, fn(REGIONS));
  set('src/geo/provinces.js', "/** Every province and territory (geography, not what we support). */\nexport const PROVINCES = {\n  AB: 'Alberta', BC: 'British Columbia', MB: 'Manitoba', NB: 'New Brunswick', NL: 'Newfoundland and Labrador', NS: 'Nova Scotia',\n  NT: 'Northwest Territories', NU: 'Nunavut', ON: 'Ontario', PE: 'Prince Edward Island', QC: 'Quebec', SK: 'Saskatchewan', YT: 'Yukon',\n};\n");
  set('src/edi/xml.js', "export const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');\n\nexport function el(name, value) {\n  return `<${name}>${esc(value)}</${name}>`;\n}\n");
  set('src/edi/segments/header.js', "import { el } from '../xml.js';\n\nexport function headerSegment(invoice) {\n  return el('InvoiceId', invoice.id) + el('IssueDate', invoice.issuedOn);\n}\n");
  set('src/edi/segments/party.js', "import { el } from '../xml.js';\nimport { partitionFor } from '../partitions.js';\n\n/** The buyer party: name and the ledger partition the gateway files the invoice under. */\nexport function partySegment(invoice) {\n  return el('BuyerName', invoice.customerName) + el('LedgerPartition', partitionFor(invoice.region));\n}\n");
  set('src/edi/segments/totals.js', "import { el } from '../xml.js';\n\nconst money = (c) => (c / 100).toFixed(2);\n\nexport function totalsSegment(invoice) {\n  return el('Subtotal', money(invoice.subtotalCents)) + el('Tax', money(invoice.taxCents)) + el('Total', money(invoice.subtotalCents + invoice.taxCents));\n}\n");
  set('src/edi/einvoice.js', "import { headerSegment } from './segments/header.js';\nimport { partySegment } from './segments/party.js';\nimport { totalsSegment } from './segments/totals.js';\n\n/**\n * The CRA e-invoice XML for an issued invoice. The tax amount is the one the\n * invoice was issued with (computed at checkout), never recomputed here.\n */\nexport function renderEInvoice(invoice) {\n  return `<EInvoice>${headerSegment(invoice)}${partySegment(invoice)}${totalsSegment(invoice)}</EInvoice>`;\n}\n");
  set('src/checkout/quote.js', "import { computeTax, REGIONS } from '../tax/rates.js';\n\n/** A checkout quote: subtotal, tax and total in cents. */\nexport function quote(lines, region) {\n  if (!REGIONS.includes(region)) throw new Error(`Checkout is not available in ${region}`);\n  const subtotalCents = lines.reduce((n, l) => n + l.qty * l.unitCents, 0);\n  const taxCents = computeTax(region, subtotalCents);\n  return { subtotalCents, taxCents, totalCents: subtotalCents + taxCents };\n}\n");
  set('src/billing/issue.js', "import { quote } from '../checkout/quote.js';\n\nlet seq = 0;\n\n/** Issue an invoice for a customer's lines; the e-invoice is rendered from this record. */\nexport function issueInvoice(customer, lines, issuedOn = '2026-10-01') {\n  const q = quote(lines, customer.region);\n  seq += 1;\n  return { id: `INV-${String(seq).padStart(5, '0')}`, issuedOn, customerName: customer.name, region: customer.region, subtotalCents: q.subtotalCents, taxCents: q.taxCents };\n}\n");
  set('src/ui/regionPicker.js', "import { REGIONS } from '../tax/rates.js';\nimport { PROVINCES } from '../geo/provinces.js';\n\nexport function regionOptions() {\n  return REGIONS.map((code) => ({ value: code, label: PROVINCES[code] ?? code }));\n}\n");

  // Noise modules and their growth plan (how many helpers each ends with).
  const noise = [];
  const seen = new Set();
  while (noise.length < 92) {
    const area = pick(rand, NOISE_AREAS);
    const noun = pick(rand, NOISE_NOUNS);
    const rel = `src/${area}/${noun}.js`;
    if (seen.has(rel)) continue;
    seen.add(rel);
    noise.push({ rel, area, noun, n: 1 + Math.floor(rand() * 3) });
  }
  for (const f of noise) set(f.rel, noiseFile(f.area, f.noun, f.n));

  set('test/rates.test.js', `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeTax, REGIONS } from '../src/tax/rates.js';

test('computes tax per region', () => {
  assert.equal(computeTax('ON', 10000), 1300);
  assert.equal(computeTax('AB', 10000), 500);
  assert.equal(computeTax('QC', 10000), 1498);
});

test('every region has a rate', () => {
  for (const r of REGIONS) assert.ok(computeTax(r, 100) >= 0);
});
`);
  set('test/einvoice.test.js', `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { issueInvoice } from '../src/billing/issue.js';
import { renderEInvoice } from '../src/edi/einvoice.js';

test('renders an e-invoice for an Ontario customer', () => {
  const inv = issueInvoice({ name: 'Acme', region: 'ON' }, [{ qty: 2, unitCents: 5000 }]);
  const xml = renderEInvoice(inv);
  assert.ok(xml.includes('<LedgerPartition>LP-01</LedgerPartition>'));
  assert.ok(xml.includes('<Tax>13.00</Tax>'));
});
`);
  set('test/checkout.test.js', `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quote } from '../src/checkout/quote.js';

test('quotes include tax', () => {
  assert.deepEqual(quote([{ qty: 1, unitCents: 10000 }], 'BC'), { subtotalCents: 10000, taxCents: 1200, totalCents: 11200 });
});
`);

  // History (fixture only): an initial import with seven regions and one
  // helper per noise module, then region additions (A + B + test together),
  // two rate reviews (A + B together), and noise commits growing helpers.
  const history = [];
  if (!ref) {
    const initial = new Map(files);
    initial.set('src/tax/rates.js', ratesFile(REGIONS.slice(0, INITIAL)));
    initial.set('src/edi/partitions.js', partitionsFile(REGIONS.slice(0, INITIAL), '2026-01-05'));
    for (const [rel, fn] of Object.entries(DECOY_LISTS)) initial.set(rel, fn(REGIONS.slice(0, INITIAL)));
    for (const f of noise) initial.set(f.rel, noiseFile(f.area, f.noun, 1));
    history.push({ message: 'Initial import', files: initial });

    const events = [];
    for (let k = INITIAL; k < REGIONS.length; k++) events.push({ kind: 'region', k });
    events.push({ kind: 'review', at: 2 }, { kind: 'review', at: 4 });
    for (const f of noise) for (let i = 2; i <= f.n; i++) events.push({ kind: 'noise', f, i });
    // Interleave: region/review events spread through the noise, deterministically.
    const ordered = events.filter((e) => e.kind === 'noise');
    const special = events.filter((e) => e.kind !== 'noise');
    special.forEach((e, j) => ordered.splice(Math.min(ordered.length, Math.round(((j + 1) * ordered.length) / (special.length + 1)) + j), 0, e));
    let regions = INITIAL;
    let reviews = 0;
    const decoyRegions = { n: INITIAL };
    for (const e of ordered) {
      const changed = new Map();
      if (e.kind === 'region') {
        regions = e.k + 1;
        const day = `2026-0${2 + Math.floor((e.k - INITIAL) / 2)}-1${e.k % 10}`;
        changed.set('src/tax/rates.js', ratesFile(REGIONS.slice(0, regions)));
        changed.set('src/edi/partitions.js', partitionsFile(REGIONS.slice(0, regions), regions === REGIONS.length ? '2026-05-18' : day));
        history.push({ message: `Support ${REGIONS[e.k][0]}: tax rate and e-invoice partition`, files: changed });
        // The decoy lists caught up separately, in their own commits.
        decoyRegions.n = regions;
        const decoys = new Map();
        for (const [rel, fn] of Object.entries(DECOY_LISTS)) decoys.set(rel, fn(REGIONS.slice(0, regions)));
        history.push({ message: `Shipping, holidays, copy and phone hints for ${REGIONS[e.k][0]}`, files: decoys });
      } else if (e.kind === 'review') {
        reviews++;
        changed.set('src/tax/rates.js', `${ratesFile(REGIONS.slice(0, regions)).replace('rounded half up.', reviews === 1 ? 'rounded half up (reviewed Q1).' : 'rounded half up (reviewed Q2).')}`);
        changed.set('src/edi/partitions.js', partitionsFile(REGIONS.slice(0, regions), `2026-0${2 + reviews}-0${reviews + 1}`));
        history.push({ message: `Quarterly rate review ${reviews}: re-check rates and partitions`, files: changed });
      } else {
        changed.set(e.f.rel, noiseFile(e.f.area, e.f.noun, e.i));
        history.push({ message: `${e.f.area}: add ${e.f.noun} helper ${e.i}`, files: changed });
      }
    }
    // Close out: the final state of the two tables (comment wording after the reviews).
    history.push({ message: 'Tidy rates and partition headers', files: new Map([['src/tax/rates.js', files.get('src/tax/rates.js')], ['src/edi/partitions.js', files.get('src/edi/partitions.js')]]) });
  }

  const decoys = Object.keys(DECOY_LISTS);
  const unrelated = [...noise.map((f) => f.rel), 'src/edi/einvoice.js', 'src/edi/xml.js', 'src/edi/segments/header.js', 'src/edi/segments/party.js', 'src/edi/segments/totals.js', 'src/checkout/quote.js', 'src/billing/issue.js', 'src/geo/provinces.js'];
  return { files, history, meta: { decoys, unrelated } };
}
