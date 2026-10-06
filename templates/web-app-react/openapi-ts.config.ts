import { defineConfig } from '@hey-api/openapi-ts';

// The typed client is generated, committed, and checked in CI (`npm run gen:check`
// regenerates it and fails on any difference), so a contract change cannot land
// without its client.
export default defineConfig({
  input: './openapi/openapi.json',
  output: { path: './src/api/generated', clean: true },
  plugins: [
    '@hey-api/client-fetch',
    '@hey-api/typescript',
    { name: '@hey-api/sdk', operations: { strategy: 'flat' } },
    '@tanstack/react-query',
    { name: 'zod', dates: { offset: true } },
  ],
});
