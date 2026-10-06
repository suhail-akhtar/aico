import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { securityHeaders } from './mock/security-headers.ts';
import { mockGateway } from './mock/vite-plugin.ts';

const apiOrigin = process.env.DEV_API_ORIGIN;
const proxy = apiOrigin
  ? { '/api': { target: apiOrigin, changeOrigin: false }, '/idp': { target: apiOrigin } }
  : undefined;

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    react(),
    tailwindcss(),
    mockGateway(),
  ],
  server: { host: '0.0.0.0', port: 5173, ...(proxy ? { proxy } : {}) },
  // `vite preview` (used by the e2e suite) serves the built app with the same
  // headers production does, so a CSP violation fails here, not in production.
  preview: { host: '0.0.0.0', port: 4173, headers: { ...securityHeaders } },
  build: { sourcemap: 'hidden', target: 'es2023' },
});
