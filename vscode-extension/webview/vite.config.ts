/**
 * Build for the VS Code panel.
 *
 * A second Vite build rather than a second application. It compiles the panel's
 * own view layer together with code taken straight from the browser client —
 * `web/src/{api,reduce,store,…}` and every component in `shared/ui` — so the two
 * surfaces share a transcript renderer, a reducer and a transport rather than
 * drifting into two implementations of the same conversation.
 *
 * Output is deliberately two fixed filenames. The webview's HTML is written by
 * hand in `src/view/provider.ts` with a strict content-security policy, and a
 * hashed asset name would mean parsing a manifest at runtime to build a `<script>`
 * tag — indirection bought for a cache that a `vscode-webview://` document does
 * not have.
 *
 * @module webview/vite.config
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const here = path.dirname(fileURLToPath(import.meta.url));
/** `vscode-extension/webview` → the repository root. */
const repoRoot = path.resolve(here, '..', '..');

export default defineConfig({
  plugins: [react()],
  root: here,
  resolve: {
    alias: {
      '@aico/ui': path.resolve(repoRoot, 'shared/ui'),
      '@web': path.resolve(repoRoot, 'web/src'),
      '@': path.resolve(here, 'src'),
    },
    /*
      Two copies of React means every hook in a shared component throws, and the
      error names neither the component nor the duplicate. The shared UI resolves
      React from the repository root and the panel from here, so they have to be
      collapsed explicitly — the browser client's config does the same.
    */
    dedupe: ['react', 'react-dom'],
  },
  build: {
    outDir: path.resolve(here, '..', 'media'),
    emptyOutDir: true,
    /*
      Off by default, and measured rather than assumed.

      Source maps are the only way to debug a webview properly, so the instinct
      is to ship them. They are 25MB against a 6MB bundle — four times the code —
      and they would go into every VSIX for the benefit of the handful of people
      who ever open the webview developer tools.

      `AICO_PANEL_SOURCEMAP=1 npm run build:panel` turns them on for those people.
    */
    sourcemap: process.env.AICO_PANEL_SOURCEMAP === '1',
    // The panel runs in Electron's Chromium. Targeting it rather than the
    // browser matrix keeps async/await and optional chaining untranspiled.
    target: 'chrome114',
    rollupOptions: {
      input: path.resolve(here, 'src/main.tsx'),
      output: {
        entryFileNames: 'panel.js',
        assetFileNames: (asset) =>
          asset.names?.[0]?.endsWith('.css') ? 'panel.css' : '[name][extname]',
        /*
          Code splitting is left on, and that is worth saying out loud because
          the obvious thing to do in a webview is to force one file.

          `shared/ui` already defers its expensive renderers — echarts, mermaid,
          katex, vega — behind dynamic `import()`, so they load the first time a
          message actually contains a chart or a diagram and never otherwise.
          Inlining them collapsed a ~350kB panel into a 6MB one that parsed all
          of Mermaid before it could draw a text reply.

          The CSP in `view/provider.ts` carries `'strict-dynamic'` for exactly
          this: a chunk imported by a nonce-trusted module inherits its trust,
          and without it every one of those imports fails at run time — visible
          only as a diagram that never appears.
        */
        chunkFileNames: 'chunks/[name]-[hash].js',
      },
    },
  },
});
