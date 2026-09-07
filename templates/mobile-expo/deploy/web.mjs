#!/usr/bin/env node
// Export the web build to dist/. Prints where it went and how to serve it.
import { execFileSync } from 'node:child_process';

console.log('Exporting the web build…');
execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['expo', 'export', '--platform', 'web'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, CI: '1' },
});
console.log('\nExported to dist/. Serve it with any static host, or locally:\n  npx serve dist');
