/**
 * Generates the large-refactor task's TypeScript repository (~200 files), as
 * the fixture the agent starts from or as the reference solution.
 *
 * Generated rather than checked in because the point is scale: 150 call
 * sites of one API across barrel imports, direct imports and namespace
 * imports, plus 40-odd files that must not change — committed by hand that is
 * a wall of near-identical files nobody would review. Deterministic (a seeded
 * LCG), so the fixture, the reference and the grader's "untouched" set always
 * agree.
 *
 * The traps a careless rename falls into are deliberate and named:
 * - `formatPriceRange` (a different export containing the old name) — a
 *   text replace corrupts it and every file that uses only it;
 * - `money.formatPrice(...)` through `import * as money` — a pattern for
 *   `formatPrice(...)` with a bare callee misses it;
 * - the barrel `src/core/index.ts` re-export — renamed with an alias, the old
 *   public name survives;
 * - the analytics wire name `'formatPrice'` (a string that must stay).
 */

/** Feature modules outside `eu/`, and inside it (those must pass 'EUR'). */
export const FEATURES = 130;
export const EU_FEATURES = 20;
export const UTILS = 40;

function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
}

const pad = (n, w = 3) => String(n).padStart(w, '0');

/** One feature module. `style`: how it imports the API; `eu`: whether it prices in EUR. */
function feature({ n, style, eu, usesRange, variant }) {
  const name = variant === 'reference' ? 'formatMoney' : 'formatPrice';
  const cur = variant === 'reference' && eu ? ", 'EUR'" : '';
  const up = eu ? '../../' : '../';
  const id = eu ? `e${pad(n, 2)}` : `f${pad(n)}`;
  const call = (arg) => (style === 'namespace' ? `money.${name}(${arg}${cur})` : `${name}(${arg}${cur})`);
  const imports = [];
  if (style === 'barrel') imports.push(`import { ${usesRange ? `${name}, formatPriceRange` : name} } from '${up}core/index.js';`);
  if (style === 'direct') imports.push(`import { ${usesRange ? `${name}, formatPriceRange` : name} } from '${up}core/money.js';`);
  if (style === 'namespace') imports.push(`import * as money from '${up}core/money.js';`);
  imports.push(`import { roundTo } from '${up}util/round.js';`);
  const range = usesRange
    ? `\n\nexport function range${id}(low: number, high: number): string {\n  return ${style === 'namespace' ? 'money.formatPriceRange' : 'formatPriceRange'}(low, high);\n}`
    : '';
  return `${imports.join('\n')}

/** One line of order ${id}. */
export interface Line${id} {
  qty: number;
  unit: number;
}

export function describe${id}(line: Line${id}): string {
  const total = roundTo(line.qty * line.unit, 2);
  return \`${id}: \${line.qty} x \${${call('line.unit')}} = \${${call('total')}}\`;
}

export function total${id}(lines: Line${id}[]): string {
  const sum = lines.reduce((acc, l) => acc + l.qty * l.unit, 0);
  return ${call('roundTo(sum, 2)')};
}${range}
`;
}

/** The repository as a map of relative path → contents. */
export function generate(variant = 'fixture') {
  const files = new Map();
  const rand = lcg(20261003);
  const ref = variant === 'reference';
  const api = ref ? 'formatMoney' : 'formatPrice';

  files.set('package.json', `${JSON.stringify({
    name: 'storefront', version: '1.0.0', private: true, type: 'module',
    scripts: {
      typecheck: 'node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json',
      build: 'node node_modules/typescript/bin/tsc -p tsconfig.json',
      test: 'node node_modules/typescript/bin/tsc -p tsconfig.json && node --test "build/test/*.test.js"',
    },
  }, null, 2)}\n`);
  files.set('tsconfig.json', `${JSON.stringify({
    compilerOptions: {
      target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true,
      outDir: 'build', rootDir: '.', skipLibCheck: true, types: [],
    },
    include: ['src', 'test', 'types'],
  }, null, 2)}\n`);
  // The two Node built-ins the tests use, declared locally: the repository
  // carries no @types/node, and needs none for this.
  files.set('types/node-test.d.ts', `declare module 'node:test' {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module 'node:assert/strict' {
  const assert: {
    equal(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
  };
  export default assert;
}
`);
  files.set('.gitignore', 'node_modules\nbuild\n.bench-build\n.bench-hidden\n');
  files.set('README.md', '# storefront\n\nPricing helpers and feature modules. `npm run typecheck`, `npm test`.\n');

  files.set('src/core/money.ts', ref
    ? `const SYMBOLS: Record<string, string> = { USD: '$', EUR: '€', GBP: '£' };

/** A price for display: the currency's symbol and two decimals. */
export function formatMoney(amount: number, currency: string = 'USD'): string {
  const symbol = SYMBOLS[currency] ?? \`\${currency} \`;
  return symbol + amount.toFixed(2);
}

/** A price band, e.g. "$5.00–$9.00". */
export function formatPriceRange(low: number, high: number): string {
  return \`\${formatMoney(low)}–\${formatMoney(high)}\`;
}

export function parsePrice(text: string): number {
  return Number(text.replace(/[^0-9.]/g, ''));
}
`
    : `/** A price for display: dollar sign and two decimals. */
export function formatPrice(amount: number): string {
  return '$' + amount.toFixed(2);
}

/** A price band, e.g. "$5.00–$9.00". */
export function formatPriceRange(low: number, high: number): string {
  return \`\${formatPrice(low)}–\${formatPrice(high)}\`;
}

export function parsePrice(text: string): number {
  return Number(text.replace(/[^0-9.]/g, ''));
}
`);
  files.set('src/core/index.ts', `export { ${api}, formatPriceRange, parsePrice } from './money.js';\n`);
  files.set('src/analytics/events.ts', `/** Wire names the analytics backend matches on — changing one silently breaks its dashboards. */
export const PRICE_FORMATTED_EVENT = 'formatPrice';
export const CHECKOUT_EVENT = 'checkout';
`);
  files.set('src/util/round.ts', 'export function roundTo(n: number, digits: number): number {\n  const f = 10 ** digits;\n  return Math.round(n * f) / f;\n}\n');

  // Unrelated utilities: must be byte-identical afterwards. Every tenth one
  // uses formatPriceRange only — a file a text replace would wrongly touch.
  for (let i = 1; i <= UTILS; i++) {
    const id = pad(i);
    const body = i % 10 === 5
      ? `import { formatPriceRange } from '../core/index.js';\n\n/** Price band label ${id}. */\nexport function band${id}(low: number, high: number): string {\n  return 'Band ${id}: ' + formatPriceRange(low, high);\n}\n`
      : `/** Helper ${id}. */\nexport function helper${id}(x: number): number {\n  return (x * ${i + 2}) % ${i + 11};\n}\n\nexport const LABEL_${id} = 'helper-${id}';\n`;
    files.set(`src/util/u${id}.ts`, body);
  }

  const styles = ['barrel', 'direct', 'namespace'];
  const meta = [];
  for (let i = 1; i <= FEATURES; i++) {
    const style = styles[Math.floor(rand() * 3)];
    const usesRange = rand() < 0.2;
    files.set(`src/features/f${pad(i)}.ts`, feature({ n: i, style, eu: false, usesRange, variant }));
    meta.push({ id: `f${pad(i)}`, file: `src/features/f${pad(i)}.ts`, eu: false, style, usesRange });
  }
  for (let i = 1; i <= EU_FEATURES; i++) {
    const style = styles[Math.floor(rand() * 3)];
    const usesRange = rand() < 0.2;
    files.set(`src/features/eu/e${pad(i, 2)}.ts`, feature({ n: i, style, eu: true, usesRange, variant }));
    meta.push({ id: `e${pad(i, 2)}`, file: `src/features/eu/e${pad(i, 2)}.ts`, eu: true, style, usesRange });
  }

  // Visible tests: the API itself, and the non-EU features in groups of 13.
  files.set('test/money.test.ts', `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ${api}, formatPriceRange } from '../src/core/index.js';

test('formats a price with two decimals', () => {
  assert.equal(${api}(12.5), '$12.50');
  assert.equal(${api}(0), '$0.00');
});

test('formats a price band', () => {
  assert.equal(formatPriceRange(5, 9), '$5.00–$9.00');
});
`);
  const plain = meta.filter((m) => !m.eu);
  for (let g = 0; g * 13 < plain.length; g++) {
    const group = plain.slice(g * 13, g * 13 + 13);
    const imports = group.map((m) => `import { describe${m.id}, total${m.id} } from '../${m.file.replace(/\.ts$/, '.js')}';`).join('\n');
    const cases = group.map((m) => `  assert.equal(describe${m.id}({ qty: 3, unit: 2.5 }), '${m.id}: 3 x $2.50 = $7.50');\n  assert.equal(total${m.id}([{ qty: 2, unit: 1.25 }, { qty: 1, unit: 4 }]), '$6.50');`).join('\n');
    files.set(`test/features-${pad(g + 1, 2)}.test.ts`, `import { test } from 'node:test';
import assert from 'node:assert/strict';
${imports}

test('feature group ${g + 1} prices lines in dollars', () => {
${cases}
});
`);
  }
  return { files, meta };
}
