import { defineConfig } from 'tsup';
import fs from 'node:fs';

// The server bundles the engine's policy schema (../src/policy/managed.ts) so it validates with the
// very code the engine reads with (ADR 0040) — one definition, no copy to drift.
export default defineConfig({
  entry: { index: 'src/index.ts', lib: 'src/lib.ts' },
  format: ['esm'],
  target: 'node22',
  clean: false,
  shims: true,
  dts: false,
  onSuccess: async () => {
    const f = 'dist/index.js';
    const s = fs.readFileSync(f, 'utf8');
    if (!s.startsWith('#!')) fs.writeFileSync(f, `#!/usr/bin/env node\n${s}`);
  },
});
