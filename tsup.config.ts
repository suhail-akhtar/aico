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
  },
});
