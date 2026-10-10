import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const here = path.dirname(fileURLToPath(import.meta.url));

// The portal is served by the control server itself (same origin: cookies and CSRF stay simple),
// so it builds into the server's dist folder. In dev, API calls go to a locally running server.
export default defineConfig({
  root: here,
  plugins: [react()],
  build: { outDir: path.resolve(here, '../dist/portal'), emptyOutDir: true, sourcemap: false },
  server: { port: 5180, proxy: { '/v1': 'http://127.0.0.1:7350', '/auth': 'http://127.0.0.1:7350', '/device': 'http://127.0.0.1:7350' } },
});
