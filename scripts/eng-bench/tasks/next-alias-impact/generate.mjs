/**
 * Generates the next-alias-impact task's repository: a Next.js-shaped
 * TypeScript storefront (~170 files) in which one shared util,
 * `formatAmount` in src/lib/format/currency.ts, gains a required `currency`
 * parameter — as the fixture the agent starts from, or as the reference.
 *
 * The shape is the one a code graph is supposed to help with and a text
 * search is not: the util is reached through the `@/` tsconfig path alias,
 * two barrels (`@/lib/format`, `@/lib`), a third barrel that re-exports it
 * under another name (`money` from `@/components/ui`), a namespace import and
 * plain relative paths; and two *other* modules export a function with the
 * same name, `formatAmount` (legacy POS receipts and the reports feature),
 * whose callers have a `currency` in scope too and must not change. PascalCase
 * component files and `(shop)` route-group folders are there because real
 * Next.js projects have them (and because they trip case- and path-sensitive
 * indexers on Windows).
 *
 * Deterministic: a seeded LCG picks every import style, so the fixture, the
 * reference and the grader's lists always agree.
 */
import path from 'path';
import { ALIAS_LOADER, ALIAS_REGISTER, GITIGNORE, lcg, pick } from '../../lib/generated.mjs';

const AREAS = ['Cart', 'Order', 'Invoice', 'Plan', 'Gift', 'Refund', 'Shipping', 'Tax', 'Discount', 'Wallet'];
const PARTS = ['Summary', 'Line', 'Badge', 'Total', 'Row', 'Card', 'Panel', 'Banner'];
const DIRS = { Cart: 'components/cart', Order: 'components/checkout', Invoice: 'features/billing/components', Plan: 'features/subscriptions', Gift: 'features/gift-cards', Refund: 'components/account', Shipping: 'components/checkout', Tax: 'components/pricing', Discount: 'components/pricing', Wallet: 'features/wallet' };
const STYLES = ['alias-direct', 'alias-format-barrel', 'alias-lib-barrel', 'ui-money', 'relative', 'namespace'];
const PAGES = ['(shop)/cart', '(shop)/checkout', '(shop)/checkout/review', '(shop)/plans', '(shop)/gift-cards', 'account/orders', 'account/orders/[id]', 'account/wallet', 'account/refunds', 'billing/invoices', 'billing/invoices/[id]', 'promo/[slug]'];

const relImport = (fromFile, target) => {
  let r = path.posix.relative(path.posix.dirname(fromFile), target);
  if (!r.startsWith('.')) r = `./${r}`;
  return r;
};

/** One caller: its import line and how it names the function. */
function callerImport(style, file) {
  switch (style) {
    case 'alias-direct': return { line: "import { formatAmount } from '@/lib/format/currency';", fn: 'formatAmount' };
    case 'alias-format-barrel': return { line: "import { formatAmount } from '@/lib/format';", fn: 'formatAmount' };
    case 'alias-lib-barrel': return { line: "import { formatAmount } from '@/lib';", fn: 'formatAmount' };
    case 'ui-money': return { line: "import { money } from '@/components/ui';", fn: 'money' };
    case 'relative': return { line: `import { formatAmount } from '${relImport(file, 'src/lib/format/currency')}';`, fn: 'formatAmount' };
    default: return { line: "import * as fmt from '@/lib/format';", fn: 'fmt.formatAmount' };
  }
}

function component({ name, file, style, ref }) {
  const { line, fn } = callerImport(style, file);
  const c = ref ? ', props.currency' : '';
  return `${line}
import type { CurrencyCode } from '@/lib';

export interface ${name}Props {
  title: string;
  cents: number;
  discountCents: number;
  currency: CurrencyCode;
}

/** ${name.replace(/([a-z])([A-Z])/g, '$1 $2')} as the storefront renders it. */
export function ${name}(props: ${name}Props): string {
  const net = props.cents - props.discountCents;
  const saving = props.discountCents > 0 ? \` (you save \${${fn}(props.discountCents${c})})\` : '';
  return \`\${props.title}: \${${fn}(net${c})}\${saving}\`;
}
`;
}

function page({ route, file, style, ref, uses }) {
  const { line, fn } = callerImport(style, file);
  const c = ref ? ', data.currency' : '';
  const imports = uses.map((u) => `import { ${u.name} } from '@/${u.file.replace(/^src\//, '').replace(/\.ts$/, '')}';`).join('\n');
  return `${line}
${imports}
import type { CurrencyCode } from '@/lib';

export interface PageData {
  title: string;
  cents: number;
  discountCents: number;
  currency: CurrencyCode;
}

/** Route /${route}. */
export default function Page(data: PageData): string {
  const sections = [
${uses.map((u) => `    ${u.name}(data),`).join('\n')}
  ];
  return [\`# \${data.title} — \${${fn}(data.cents${c})}\`, ...sections].join('\\n');
}
`;
}

/** A decoy caller: same function name, another module, a currency in scope it must not pass. */
function posReceipt({ n, file, viaAlias }) {
  const from = viaAlias ? '@/legacy/pos/formatAmount' : relImport(file, 'src/legacy/pos/formatAmount');
  return `import { formatAmount } from '${from}';
import type { CurrencyCode } from '@/lib';

/** Thermal-printer receipt line ${n}. POS terminals are US-only and print the ISO code. */
export interface ReceiptLine${n} {
  sku: string;
  cents: number;
  currency: CurrencyCode;
}

export function receiptLine${n}(line: ReceiptLine${n}): string {
  return \`\${line.sku.padEnd(12)}\${formatAmount(line.cents)}\`;
}
`;
}

function reportRow({ n, file, viaAlias }) {
  const from = viaAlias ? '@/features/reports/lib/formatAmount' : relImport(file, 'src/features/reports/lib/formatAmount');
  return `import { formatAmount } from '${from}';
import type { CurrencyCode } from '@/lib';

/** Finance report ${n}: whole units with thousands separators, currency shown in its own column. */
export interface ReportRow${n} {
  label: string;
  total: number;
  currency: CurrencyCode;
}

export function reportRow${n}(row: ReportRow${n}): string {
  return [row.label, formatAmount(row.total), row.currency].join(' | ');
}
`;
}

/** The repository as a map of relative path → contents, and the grader's metadata. */
export function generate(variant = 'fixture') {
  const ref = variant === 'reference';
  const rand = lcg(20261005);
  const files = new Map();

  files.set('package.json', `${JSON.stringify({
    name: 'storefront-web', version: '0.9.0', private: true, type: 'module',
    scripts: {
      typecheck: 'node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json',
      build: 'node node_modules/typescript/bin/tsc -p tsconfig.json',
      test: 'node node_modules/typescript/bin/tsc -p tsconfig.json && node --import ./scripts/register.mjs --test "build/test/*.test.js"',
    },
  }, null, 2)}\n`);
  files.set('tsconfig.json', `${JSON.stringify({
    compilerOptions: {
      target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true,
      baseUrl: '.', paths: { '@/*': ['src/*'] },
      outDir: 'build', rootDir: '.', skipLibCheck: true, types: [],
    },
    include: ['src', 'test', 'types'],
  }, null, 2)}\n`);
  files.set('next.config.mjs', "/** @type {import('next').NextConfig} */\nconst nextConfig = { reactStrictMode: true, poweredByHeader: false };\n\nexport default nextConfig;\n");
  files.set('.gitignore', GITIGNORE);
  files.set('README.md', '# storefront-web\n\nThe storefront\'s rendering layer: route modules under `src/app`, components, features.\nImports use the `@/` alias for `src/` (see tsconfig `paths`).\n\n`npm run typecheck`, `npm test`.\n');
  files.set('scripts/alias-loader.mjs', ALIAS_LOADER);
  files.set('scripts/register.mjs', ALIAS_REGISTER);
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

  // The util under change, its barrels, and the lib around it.
  files.set('src/lib/money/types.ts', "/** ISO 4217 codes the storefront sells in. */\nexport type CurrencyCode = 'USD' | 'EUR' | 'GBP';\n\nexport const CURRENCIES: CurrencyCode[] = ['USD', 'EUR', 'GBP'];\n");
  files.set('src/lib/format/currency.ts', ref
    ? `import type { CurrencyCode } from '@/lib/money/types';

const SYMBOLS: Record<CurrencyCode, string> = { USD: '$', EUR: '€', GBP: '£' };

/** Minor units (cents) to a display string in the given currency, e.g. (1234, 'EUR') -> "€12.34". */
export function formatAmount(cents: number, currency: CurrencyCode): string {
  return SYMBOLS[currency] + (cents / 100).toFixed(2);
}

/** "12.34" without a symbol, for form inputs. */
export function plainAmount(cents: number): string {
  return (cents / 100).toFixed(2);
}
`
    : `/** Minor units (cents) to a display string, e.g. 1234 -> "$12.34". */
export function formatAmount(cents: number): string {
  return '$' + (cents / 100).toFixed(2);
}

/** "12.34" without a symbol, for form inputs. */
export function plainAmount(cents: number): string {
  return (cents / 100).toFixed(2);
}
`);
  files.set('src/lib/format/dates.ts', "/** ISO date (YYYY-MM-DD) to \"5 Oct 2026\". */\nexport function formatDate(iso: string): string {\n  const [y, m, d] = iso.split('-').map(Number);\n  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];\n  return `${d} ${months[m - 1]} ${y}`;\n}\n");
  files.set('src/lib/format/index.ts', "export * from './currency';\nexport * from './dates';\n");
  files.set('src/lib/text/slugify.ts', "export function slugify(text: string): string {\n  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');\n}\n");
  files.set('src/lib/index.ts', "export { formatAmount, plainAmount, formatDate } from './format';\nexport type { CurrencyCode } from './money/types';\nexport { CURRENCIES } from './money/types';\nexport { slugify } from './text/slugify';\n");
  files.set('src/components/ui/badge.ts', "export function badge(text: string): string {\n  return `[${text}]`;\n}\n");
  files.set('src/components/ui/pill.ts', "export function pill(text: string, tone: 'info' | 'warn' = 'info'): string {\n  return tone === 'warn' ? `(!${text})` : `(${text})`;\n}\n");
  files.set('src/components/ui/index.ts', "export { formatAmount as money } from '@/lib/format/currency';\nexport { badge } from './badge';\nexport { pill } from './pill';\n");

  // Same-named decoys.
  files.set('src/legacy/pos/formatAmount.ts', "/** POS receipts: US terminals only, ISO code first, e.g. \"USD 12.34\". Do not localise: the printers' firmware parses it. */\nexport function formatAmount(cents: number): string {\n  return 'USD ' + (cents / 100).toFixed(2);\n}\n");
  files.set('src/features/reports/lib/formatAmount.ts', "/** Finance reports: whole units with thousands separators, e.g. 1234567 -> \"1,234,567\". */\nexport function formatAmount(value: number): string {\n  return String(Math.round(value)).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',');\n}\n");

  // Unrelated modules (must stay byte-identical).
  const unrelated = [];
  const hooks = ['useCart', 'useSession', 'useLocale', 'useFeatureFlag', 'useDebounce', 'usePagination', 'useToast', 'useTheme'];
  for (const h of hooks) {
    const rel = `src/hooks/${h}.ts`;
    files.set(rel, `/** ${h}: framework-free state holder used by the route modules. */\nexport function ${h}<T>(initial: T): { get(): T; set(v: T): void } {\n  let value = initial;\n  return { get: () => value, set: (v: T) => { value = v; } };\n}\n`);
    unrelated.push(rel);
  }
  const http = ['client', 'retry', 'errors', 'headers', 'query'];
  for (const h of http) {
    const rel = `src/lib/http/${h}.ts`;
    files.set(rel, `/** HTTP ${h} helpers. */\nexport function ${h}Label(path: string): string {\n  return '${h}:' + path;\n}\n`);
    unrelated.push(rel);
  }
  for (let i = 1; i <= 12; i++) {
    const rel = `src/features/catalog/filters/filter${String(i).padStart(2, '0')}.ts`;
    files.set(rel, `import { slugify } from '@/lib';\n\n/** Catalog facet ${i}. */\nexport function facet${i}(label: string): string {\n  return 'f${i}-' + slugify(label);\n}\n`);
    unrelated.push(rel);
  }

  // Real callers: components.
  const callers = [];
  for (const area of AREAS) {
    for (const part of PARTS) {
      const name = `${area}${part}`;
      const file = `src/${DIRS[area]}/${name}.ts`;
      const style = pick(rand, STYLES);
      files.set(file, component({ name, file, style, ref }));
      callers.push({ kind: 'component', name, file, style });
    }
  }
  // Real callers: route modules, each composing two components.
  for (const route of PAGES) {
    const file = `src/app/${route}/page.ts`;
    const style = pick(rand, STYLES);
    const uses = [pick(rand, callers.filter((c) => c.kind === 'component')), pick(rand, callers.filter((c) => c.kind === 'component'))]
      .filter((u, i, a) => a.findIndex((x) => x.name === u.name) === i);
    files.set(file, page({ route, file, style, ref, uses }));
    callers.push({ kind: 'page', name: 'default', file, style, uses: uses.map((u) => u.name) });
  }

  // Decoy callers.
  const decoys = ['src/legacy/pos/formatAmount.ts', 'src/features/reports/lib/formatAmount.ts'];
  const decoyCallers = [];
  for (let i = 1; i <= 15; i++) {
    const file = `src/legacy/pos/receipts/receipt${String(i).padStart(2, '0')}.ts`;
    files.set(file, posReceipt({ n: String(i).padStart(2, '0'), file, viaAlias: rand() < 0.5 }));
    decoyCallers.push({ kind: 'pos', n: i, file });
  }
  for (let i = 1; i <= 15; i++) {
    const file = `src/features/reports/report${String(i).padStart(2, '0')}.ts`;
    files.set(file, reportRow({ n: String(i).padStart(2, '0'), file, viaAlias: rand() < 0.5 }));
    decoyCallers.push({ kind: 'report', n: i, file });
  }

  // Visible tests: the util itself and a sample of components, in dollars.
  const C = ref ? ", 'USD'" : '';
  files.set('test/currency.test.ts', `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatAmount, plainAmount } from '@/lib/format/currency';

test('formats cents for display', () => {
  assert.equal(formatAmount(1234${C}), '$12.34');
  assert.equal(formatAmount(0${C}), '$0.00');
  assert.equal(plainAmount(5), '0.05');
});
`);
  const sample = callers.filter((c) => c.kind === 'component').filter((_, i) => i % 9 === 0);
  files.set('test/components.test.ts', `import { test } from 'node:test';
import assert from 'node:assert/strict';
${sample.map((c) => `import { ${c.name} } from '@/${c.file.slice(4, -3)}';`).join('\n')}

test('components render dollar prices', () => {
${sample.map((c) => `  assert.equal(${c.name}({ title: 'T', cents: 1234, discountCents: 234, currency: 'USD' }), 'T: $10.00 (you save $2.34)');`).join('\n')}
});
`);
  files.set('test/reports.test.ts', `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reportRow01 } from '@/features/reports/report01';
import { receiptLine01 } from '@/legacy/pos/receipts/receipt01';

test('reports and receipts keep their own formats', () => {
  assert.equal(reportRow01({ label: 'Q3', total: 1234567, currency: 'EUR' }), 'Q3 | 1,234,567 | EUR');
  assert.equal(receiptLine01({ sku: 'A-1', cents: 1234, currency: 'USD' }), 'A-1         USD 12.34');
});
`);

  return { files, meta: { callers, decoyCallers, decoys, unrelated } };
}
