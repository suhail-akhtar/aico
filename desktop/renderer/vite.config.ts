/**
 * The desktop interface.
 *
 * Its own view layer, compiled together with the browser client's state layer
 * (`web/src` — api, store, reducer) and every renderer in `shared/ui`, exactly
 * as the VS Code panel is. Two surfaces, one conversation model.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const repoRoot = path.resolve(desktop, '..');
const version = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version;
const desktopVersion = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8')).version;

export default defineConfig({
  root: here,
  base: './',
  plugins: [react()],
  define: {
    __AICO_VERSION__: JSON.stringify(version),
    __DESKTOP_VERSION__: JSON.stringify(desktopVersion),
  },
  resolve: {
    alias: [
      // One copy of zustand for the shared store and this app — exact matches,
      // so 'zustand/vanilla' is not rewritten to the CommonJS build.
      { find: /^zustand$/, replacement: path.resolve(repoRoot, 'web/node_modules/zustand/esm/index.mjs') },
      { find: /^zustand\/(vanilla|react|middleware|shallow|traditional)$/, replacement: path.resolve(repoRoot, 'web/node_modules/zustand/esm') + '/$1.mjs' },
      ...Object.entries({
      '@aico/ui': path.resolve(repoRoot, 'shared/ui'),
      '@aico/reasoning': path.resolve(repoRoot, 'shared/reasoning.ts'),
      '@aico/shared': path.resolve(repoRoot, 'shared'),
      '@web': path.resolve(repoRoot, 'web/src'),
      '@desk': path.resolve(desktop, 'shared'),
      '@': path.resolve(here, 'src'),
    }).map(([find, replacement]) => ({ find, replacement })),
    ],
    dedupe: ['react', 'react-dom', 'echarts'],
  },
  build: {
    outDir: path.resolve(desktop, 'dist/renderer'),
    emptyOutDir: true,
    sourcemap: true,
    chunkSizeWarningLimit: 6000,
    minify: process.env.AICO_NO_MINIFY ? false : 'esbuild',
    target: 'chrome140',
    // Three pages: the interface, the floating copilot's own view over the browser page, and the
    // browser's own window when it is popped out (browser-main.tsx).
    rollupOptions: { input: { main: path.join(here, 'index.html'), copilot: path.join(here, 'copilot.html'), browser: path.join(here, 'browser.html') } },
  },
  worker: { format: 'es' },
});
