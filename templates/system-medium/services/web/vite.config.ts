import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the API is the compose stack behind the proxy on :8080 (make up). The app and the
// API must share one origin because the session is a cookie: run `npm run dev` with the stack up
// and the dev server proxies the API paths, so sign-in works exactly as in production.
const stack = process.env.DEV_STACK_ORIGIN ?? 'http://localhost:8080';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': stack,
      '/oauth2': stack,
      '/login': stack,
    },
  },
  build: { sourcemap: false, target: 'es2023' },
});
