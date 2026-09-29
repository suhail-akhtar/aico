/**
 * Build AICO Desktop.
 *
 *   node scripts/build.mjs            main + preload + engine + renderer
 *   node scripts/build.mjs --no-renderer
 *
 * Three bundles and a Vite build, all into `dist/`:
 *   dist/main.cjs        Electron main process
 *   dist/preload.cjs     the renderer's only bridge to main
 *   dist/engine/         the AICO engine (serve()), with its built-in skills and
 *                        app templates beside it where the loaders look
 *   dist/renderer/       the interface (index.html), the floating copilot's
 *                        own view over the browser page (copilot.html), and
 *                        the browser's own window when popped out (browser.html)
 *
 * @module desktop/scripts/build
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const repo = path.resolve(desktop, '..');
const dist = path.join(desktop, 'dist');
const args = new Set(process.argv.slice(2));

const rootPkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
const deskPkg = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8'));

fs.mkdirSync(dist, { recursive: true });

const define = {
  __AICO_VERSION__: JSON.stringify(rootPkg.version),
  __DESKTOP_VERSION__: JSON.stringify(deskPkg.version),
};

// ── Main and preload: CommonJS, Electron provides `electron`. ───────────────
await build({
  entryPoints: [path.join(desktop, 'electron/main.ts')],
  outfile: path.join(dist, 'main.cjs'),
  bundle: true, platform: 'node', format: 'cjs', target: 'node24',
  // electron-updater stays a real dependency (loaded only in a packaged build).
  external: ['electron', '@lydell/node-pty', 'playwright-core', 'electron-updater'], define, sourcemap: 'linked', logLevel: 'warning',
});
await build({
  entryPoints: [path.join(desktop, 'electron/preload.ts')],
  outfile: path.join(dist, 'preload.cjs'),
  bundle: true, platform: 'node', format: 'cjs', target: 'node24',
  external: ['electron'], define, logLevel: 'warning',
});

// ── The engine: ESM, everything bundled except what cannot be. ──────────────
const engineDir = path.join(dist, 'engine');
fs.rmSync(engineDir, { recursive: true, force: true });
await build({
  entryPoints: [path.join(desktop, 'engine/entry.ts')],
  outfile: path.join(engineDir, 'engine.mjs'),
  bundle: true, platform: 'node', format: 'esm', target: 'node24',
  // CommonJS dependencies inside an ESM bundle still call require().
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  // Playwright ships browser-launch assets it finds relative to itself, and the
  // terminal UI's optional devtools hook is never used by a server.
  external: ['playwright-core', 'react-devtools-core', 'electron'],
  jsx: 'transform', jsxFactory: 'React.createElement', jsxFragment: 'React.Fragment',
  loader: { '.node': 'file' },
  define, logLevel: 'warning',
});
fs.cpSync(path.join(repo, 'src/skills/builtin'), path.join(engineDir, 'builtin'), { recursive: true });
fs.cpSync(path.join(repo, 'templates'), path.join(engineDir, 'templates'), {
  recursive: true,
  filter: (src) => !/[\\/](node_modules|\.next|\.astro|\.expo|dist|coverage|data)([\\/]|$)/.test(src),
});
// `createRequire(import.meta.url)('../package.json')` in the MCP server reads
// the version one level up from the bundle.
fs.writeFileSync(path.join(dist, 'package.json'), JSON.stringify({ name: 'aico-desktop-dist', version: rootPkg.version }));

// ── Renderer ────────────────────────────────────────────────────────────────
if (!args.has('--no-renderer')) {
  const { build: viteBuild } = await import('vite');
  await viteBuild({ configFile: path.join(desktop, 'renderer/vite.config.ts'), logLevel: 'warn' });
}

console.log(`built AICO Desktop ${deskPkg.version} (engine ${rootPkg.version}) → ${path.relative(repo, dist)}`);
