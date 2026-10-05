/**
 * Code graph performance on a generated project (ADR 0028): full index time,
 * memory, an incremental refresh after an edit and after a new file, a
 * no-change refresh, the view payload's size, and a symbol query.
 *
 *   node scripts/codegraph-perf.mjs [--files 5000] [--max-index-ms N]
 *
 * The project is TypeScript shaped like a real app — feature folders,
 * barrels, `@/` aliases, shared utils with many importers — plus a slice of
 * Python and Go, so resolution does real work rather than counting files.
 * Prints JSON; with `--max-index-ms` it fails above that bound (used by
 * `npm test` at a smaller size).
 */

// A store of this process's own — nothing below may touch ~/.aico. Must stay first.
import './lib/test-home.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const T = await import(pathToFileURL(process.env.AICO_TEST_EXPORTS ?? path.join(here, '..', 'dist-test', 'test-exports.js')).href);
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : fallback; };
const N = Number(arg('files', '5000'));
const maxIndexMs = Number(arg('max-index-ms', '0'));

/** A deterministic project of about N files. */
function generate(root, n) {
  const files = new Map();
  files.set('tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }));
  files.set('package.json', JSON.stringify({ name: 'perf-app', private: true }));
  files.set('go.mod', 'module example.com/perf\n');
  const utils = 40;
  for (let u = 0; u < utils; u++) {
    files.set(`src/lib/util${u}.ts`, `/** Util ${u}. */\nexport function util${u}(x: number): number { return x + ${u}; }\nexport const K${u} = ${u};\n`);
  }
  files.set('src/lib/index.ts', Array.from({ length: utils }, (_, u) => `export * from './util${u}';`).join('\n') + '\n');
  const ts = Math.floor(n * 0.85);
  const features = Math.max(1, Math.floor(ts / 50));
  let made = utils + 1;
  for (let f = 0; f < features && made < ts; f++) {
    const barrel = [];
    for (let k = 0; k < 49 && made < ts; k++, made++) {
      const name = `Comp${f}x${k}`;
      const u1 = (f * 7 + k) % utils;
      const u2 = (f * 3 + k * 5) % utils;
      const via = k % 3 === 0 ? `import { util${u1} } from '@/lib';` : `import { util${u1} } from '@/lib/util${u1}';`;
      const sibling = k > 0 ? `import { Comp${f}x${k - 1} } from './Comp${f}x${k - 1}';\n` : '';
      const cross = f > 0 && k === 1 ? `import { Comp${f - 1}x0 } from '@/features/f${f - 1}';\n` : '';
      files.set(`src/features/f${f}/${name}.tsx`, `${via}\nimport * as lib from '@/lib';\n${sibling}${cross}\n/** ${name}. */\nexport function ${name}(p: { n: number }): string {\n  const a = util${u1}(p.n);\n  const b = lib.util${u2}(a);\n  return \`<div>\${a + b}</div>\`;\n}\n`);
      barrel.push(`export { ${name} } from './${name}';`);
    }
    files.set(`src/features/f${f}/index.ts`, barrel.join('\n') + '\n');
    made++;
  }
  const py = Math.floor(n * 0.1);
  files.set('pyapp/__init__.py', '');
  files.set('pyapp/core.py', 'def core(x):\n    return x\n');
  for (let p = 0; p < py; p++) files.set(`pyapp/mod${p}.py`, `from pyapp.core import core\nfrom . import mod${Math.max(0, p - 1)}\n\ndef run${p}(x):\n    return core(x)\n`);
  const go = n - files.size;
  for (let g = 0; g < go; g++) {
    const pkg = `p${g % 20}`;
    files.set(`internal/${pkg}/f${g}.go`, `package ${pkg}\n\nimport "example.com/perf/internal/p${(g + 1) % 20}"\n\nfunc F${g}() int { return p${(g + 1) % 20}.F${(g + 1) % go}() }\n`);
  }
  for (const [rel, text] of files) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return files.size;
}

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'aico-cg-perf-')));
const written = generate(root, N);
const mb = (b) => Math.round(b / 1024 / 1024 * 10) / 10;
global.gc?.();
const heap0 = process.memoryUsage().heapUsed;
const rss0 = process.memoryUsage().rss;

T.resetCodeGraphCache();
let t = performance.now();
const g = await T.getCodeGraph(root, { force: true });
const fullMs = Math.round(performance.now() - t);
const heap1 = process.memoryUsage().heapUsed;
const rss1 = process.memoryUsage().rss;

t = performance.now();
await T.getCodeGraph(root, { force: true });
const noChangeMs = Math.round(performance.now() - t);

fs.appendFileSync(path.join(root, 'src/lib/util3.ts'), 'export const extra = 1;\n');
t = performance.now();
const g2 = await T.getCodeGraph(root, { force: true });
const editMs = Math.round(performance.now() - t);

fs.writeFileSync(path.join(root, 'src/features/new.ts'), "import { util1 } from '@/lib';\nexport const fresh = util1(1);\n");
t = performance.now();
const g3 = await T.getCodeGraph(root, { force: true });
const addMs = Math.round(performance.now() - t);

T.resetCodeGraphCache();
await new Promise(r => setTimeout(r, 500));
t = performance.now();
const g4 = await T.getCodeGraph(root, { force: true });
const warmStartMs = Math.round(performance.now() - t);

t = performance.now();
const users = T.cgSymbolUsers(g3, T.cgFindFile(g3, 'src/lib/util1.ts').id, 'util1');
const queryMs = Math.round((performance.now() - t) * 100) / 100;
const payload = JSON.stringify(T.cgViewPayload(g3));
const storeDir = path.join(process.env.AICO_HOME, 'codegraph');
const storeBytes = fs.existsSync(storeDir) ? fs.readdirSync(storeDir).reduce((n, f) => n + fs.statSync(path.join(storeDir, f)).size, 0) : 0;

const result = {
  files: written, indexed: g.files.length, edges: g.edges.length, communities: g.communities.length,
  fullIndexMs: fullMs, resolveMs: g.stats.resolveMs, noChangeRefreshMs: noChangeMs, oneEditRefreshMs: editMs, oneEditParsed: g2.stats.parsed,
  newFileRefreshMs: addMs, newFileParsed: g3.stats.parsed, restartFromStoreMs: warmStartMs, restartParsed: g4.stats.parsed,
  heapMB: mb(heap1 - heap0), rssMB: mb(rss1 - rss0), storeMB: mb(storeBytes), payloadMB: mb(payload.length),
  util1Users: users.length, symbolQueryMs: queryMs,
};
console.log(JSON.stringify(result, null, 2));
fs.rmSync(root, { recursive: true, force: true });
if (maxIndexMs && fullMs > maxIndexMs) { console.log(`FAIL full index ${fullMs} ms > ${maxIndexMs} ms`); process.exit(1); }
if (users.length === 0 || g3.stats.parsed !== 1 || g2.stats.parsed !== 1) { console.log('FAIL incremental or query sanity'); process.exit(1); }
console.log('codegraph-perf: ok');
process.exit(0);
