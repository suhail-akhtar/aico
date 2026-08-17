#!/usr/bin/env node
// Patches vscode-jsonrpc/package.json to add missing ESM exports map.
// Required because the installed 8.2.1 build omits the exports field,
// causing ERR_MODULE_NOT_FOUND for "vscode-jsonrpc/node" on Node 18+.
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const root = resolve(fileURLToPath(import.meta.url), '../../node_modules/vscode-jsonrpc/package.json');
const pkg = JSON.parse(readFileSync(root, 'utf8'));

if (!pkg.exports || !pkg.exports['./node']) {
  pkg.exports = {
    '.': './lib/node/main.js',
    './node': './node.js',
    './node.js': './node.js',
    './browser': './browser.js',
    './browser.js': './browser.js',
  };
  writeFileSync(root, JSON.stringify(pkg, null, '\t') + '\n');
  console.log('✔ patched vscode-jsonrpc exports');
}
