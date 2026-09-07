#!/usr/bin/env node
// Build, then produce the tarball `npm publish` would upload. Prints how to install it.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
console.log(`Building ${pkg.name} ${pkg.version}…`);
execFileSync(npm, ['run', 'build'], { stdio: 'inherit', shell: process.platform === 'win32' });
const out = execFileSync(npm, ['pack', '--json'], { encoding: 'utf8', shell: process.platform === 'win32' });
const file = JSON.parse(out)[0]?.filename ?? `${pkg.name}-${pkg.version}.tgz`;
console.log(`\nPacked ${file}. Install it anywhere with:\n  npm install -g ./${file}\nthen run: ${Object.keys(pkg.bin ?? {})[0] ?? pkg.name} --help`);
