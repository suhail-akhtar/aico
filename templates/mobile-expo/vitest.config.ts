import { defineConfig } from 'vitest/config';

// The pure logic only: React Native rendering is exercised by opening the app,
// not by a jsdom that cannot host it.
export default defineConfig({
  test: { include: ['test/**/*.test.ts'], environment: 'node' },
});
