import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

/** Where `aico serve` looks for the built client. */
const OUT_DIR = path.resolve(repoRoot, 'web-dist');
/** The port `aico serve` listens on, for the dev proxy. */
const API_PORT = Number(process.env.AICO_PORT ?? 7317);

export default defineConfig({
  plugins: [react()],
  root: here,
  base: './',
  resolve: {
    alias: {
      '@aico/ui': path.resolve(repoRoot, 'shared/ui'),
      '@': path.resolve(here, 'src'),
    },
    // The shared components live outside this project, so `react` resolves from
    // the repo root for them and from here for app code. Two copies of React
    // means every hook in a shared component throws. Dedupe collapses them.
    dedupe: ['react', 'react-dom'],
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${API_PORT}`,
        changeOrigin: true,
        // The server refuses foreign Origins on purpose. In dev the page is on
        // :5173, so present the proxy hop as same-origin rather than weakening
        // the check that exists to stop a stray tab driving the agent.
        headers: { Origin: `http://127.0.0.1:${API_PORT}` },
        // SSE must not be buffered or the stream arrives all at once, at the end.
        ws: false,
      },
    },
  },
  build: {
    outDir: OUT_DIR,
    emptyOutDir: true,
    sourcemap: true,
  },
});
