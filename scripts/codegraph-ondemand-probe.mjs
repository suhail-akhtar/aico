/**
 * On-demand exact TS/JS callers on a project over the whole-project checker's
 * limit (src/codegraph/ts-ondemand), checked against the TypeScript
 * compiler's own answer on the full program.
 *
 *   node scripts/codegraph-ondemand-probe.mjs [--root <dir>] [--file src/home.ts] [--name aicoHome]
 *
 * Defaults to this repository (over the limit: ~1,450 TS/JS files, ~16 MB) and
 * `aicoHome`, an exported function used across the engine. It builds the code
 * graph (temp store), asks for the symbol's users on demand — the time, the
 * worker's heap, the program size — then builds a language service over
 * *every* indexed TS/JS file and runs `findReferences` at the same position,
 * classifying references the same way (a re-export is not a use), and
 * requires the two caller sets to be equal. A second ask must come from the
 * cache. Not in `npm test` (the full-program reference takes ~2 GB and tens
 * of seconds); no model, no network.
 */

// A store of this process's own — nothing below may touch ~/.aico. Must stay first.
import './lib/test-home.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const T = await import(pathToFileURL(process.env.AICO_TEST_EXPORTS ?? path.join(here, '..', 'dist-test', 'test-exports.js')).href);
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const root = path.resolve(arg('root', path.join(here, '..')));
const fileRel = arg('file', 'src/home.ts');
const name = arg('name', 'aicoHome');

const t0 = Date.now();
const g = await T.getCodeGraph(root, { force: true });
const indexMs = Date.now() - t0;
const fileId = T.cgFindFile(g, fileRel).id;
if (fileId === undefined) { console.error(`no ${fileRel} in the graph`); process.exit(2); }
console.log(`graph: ${g.files.length} files in ${indexMs} ms — ${g.stats.methods?.note}`);
if (!g.stats.methods?.overCap) { console.error('this project is not over the whole-project limit; the on-demand path does not apply'); process.exit(2); }

const od = await T.cgExactUsersOnDemand(g, fileId, name, { budgetMs: 120_000 });
const onDemand = new Set(od.users.filter(u => u.via === 'ondemand').map(u => g.files[u.file].path));
console.log(`on demand: ${od.status}, ${onDemand.size} caller files, ${od.ms} ms, worker heap ${od.heapMB} MB, ${od.programFiles} files in the program${od.disposed ? ' (disposed: over the cap)' : ''}`);
const again = await T.cgExactUsersOnDemand(g, fileId, name);
console.log(`asked again: ${again.cached ? 'cached' : 'NOT cached'} in ${again.ms} ms`);

// The compiler's answer on the whole program.
const req = createRequire(path.join(root, 'package.json'));
const ts = req('typescript');
const fwd = (f) => path.resolve(f).split(path.sep).join('/');
const all = g.files.filter(f => /\.[cm]?[jt]sx?$/.test(f.path) && !/\.d\.[cm]?ts$/.test(f.path)).map(f => fwd(path.join(root, f.path)));
const cfg = ts.findConfigFile(root, ts.sys.fileExists);
const options = { ...(cfg ? ts.parseJsonConfigFileContent(ts.readConfigFile(cfg, ts.sys.readFile).config, ts.sys, path.dirname(cfg)).options : {}), noEmit: true, allowJs: true, skipLibCheck: true, types: [] };
const host = {
  getScriptFileNames: () => all, getScriptVersion: () => '1',
  getScriptSnapshot: (f) => { try { return ts.ScriptSnapshot.fromString(fs.readFileSync(f, 'utf8')); } catch { return undefined; } },
  getCurrentDirectory: () => root, getCompilationSettings: () => options, getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
  fileExists: ts.sys.fileExists, readFile: ts.sys.readFile, readDirectory: ts.sys.readDirectory, directoryExists: ts.sys.directoryExists, getDirectories: ts.sys.getDirectories,
  resolveModuleNames: (names, containing) => names.map(n => { const r = ts.resolveModuleName(n, containing, options, ts.sys).resolvedModule; return r && !/[\\/]node_modules[\\/]/.test(r.resolvedFileName) ? r : undefined; }),
};
const t1 = Date.now();
const ls = ts.createLanguageService(host, ts.createDocumentRegistry());
const declAbs = fwd(path.join(root, fileRel));
const program = ls.getProgram();
const sf = program.getSourceFile(declAbs);
const decl = g.files[fileId].exports.find(e => e.name === name);
const member = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name;
const start = sf.getLineStarts()[decl.line - 1];
const pos = start + sf.text.slice(start).search(new RegExp(`(?<![\\w$])${member}(?![\\w$])`));
const truth = new Set();
for (const group of ls.findReferences(declAbs, pos) ?? []) {
  const self = (fwd(group.definition.fileName).toLowerCase() === declAbs.toLowerCase() && group.definition.textSpan.start <= pos && pos < group.definition.textSpan.start + group.definition.textSpan.length) || group.definition.kind === 'alias';
  if (!self) continue;
  for (const r of group.references) {
    if (r.isDefinition) continue;
    const rsf = program.getSourceFile(r.fileName);
    let node = ts.getTokenAtPosition(rsf, r.textSpan.start);
    let reexport = false;
    for (let k = 0; node && k < 4; k++, node = node.parent) if (ts.isExportSpecifier(node)) { reexport = true; break; }
    const rel = path.relative(root, r.fileName).split(path.sep).join('/');
    if (!reexport && rel.toLowerCase() !== fileRel.toLowerCase()) truth.add(rel);
  }
}
const fullMs = Date.now() - t1;
const fullHeap = Math.round(process.memoryUsage().heapUsed / 1e6);
console.log(`full program (tsc language service): ${truth.size} caller files, ${program.getSourceFiles().length} files, ${fullMs} ms, heap ${fullHeap} MB`);

const missing = [...truth].filter(x => !onDemand.has(x));
const extra = [...onDemand].filter(x => !truth.has(x));
const equal = od.status === 'exact' && missing.length === 0 && extra.length === 0;
console.log(equal ? `EQUAL: on-demand caller set = findReferences on the full program (${truth.size} files)` : `DIFFERENT: missing ${JSON.stringify(missing)} extra ${JSON.stringify(extra)}`);
console.log(JSON.stringify({ symbol: `${fileRel}#${name}`, callers: truth.size, onDemandMs: od.ms, onDemandHeapMB: od.heapMB, onDemandProgramFiles: od.programFiles, cachedMs: again.ms, fullMs, fullHeapMB: fullHeap, equal }));
await T.cgDisposeOnDemand();
process.exit(equal && again.cached ? 0 : 1);
