import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    environmentOptions: { jsdom: { url: 'http://localhost:3000/' } },
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}', 'mock/**/*.test.ts', 'scripts/**/*.test.ts'],
    css: false,
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary'],
      include: [
        'src/**/*.{ts,tsx}',
        'mock/api.ts',
        'mock/security-headers.ts',
        'scripts/audit-lib.ts',
      ],
      exclude: [
        'src/api/generated/**',
        'src/routeTree.gen.ts',
        'src/test/**',
        'src/**/*.test.{ts,tsx}',
        'src/main.tsx',
        'src/shared/browser.ts',
        'src/shared/zod-config.ts',
        'src/vite-env.d.ts',
      ],
      thresholds: { lines: 85, statements: 85, functions: 85, branches: 80 },
    },
  },
});
