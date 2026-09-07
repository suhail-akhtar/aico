import { defineConfig } from 'tsup';
import fs from 'fs';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node18',
  clean: true,
  shims: true,
  jsx: 'react',
  // Add shebang only to the CLI entry file, not shared chunks
  onSuccess: async () => {
    const entry = 'dist/index.js';
    const src = fs.readFileSync(entry, 'utf8');
    if (!src.startsWith('#!')) {
      fs.writeFileSync(entry, '#!/usr/bin/env node\n' + src);
    }
    // Copy built-in skill markdown files to dist so the skill loader can find them
    if (fs.existsSync('src/skills/builtin')) {
      fs.cpSync('src/skills/builtin', 'dist/skills/builtin', { recursive: true });
    }
    // App templates ship as files: copied for zero model tokens, never generated.
    // `node_modules` in a template is a local convenience for running its tests
    // and must not travel; the lockfile is what makes an install deterministic.
    if (fs.existsSync('templates')) {
      fs.cpSync('templates', 'dist/templates', {
        recursive: true,
        filter: (src) => !/[\\/](node_modules|\.next|\.astro|\.expo|dist|coverage|data)([\\/]|$)/.test(src),
      });
    }
  },
});
