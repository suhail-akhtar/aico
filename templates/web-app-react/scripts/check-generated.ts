/**
 * `npm run gen:check`: fail if generated code is out of date with its source.
 *
 * Two files are generated and committed: the typed API client
 * (`src/api/generated`, from openapi/openapi.json) and the router's
 * `src/routeTree.gen.ts` (from the files under src/routes). Committing them
 * keeps `tsc` and the tests working without a prior build; this check makes sure
 * that cannot hide a stale copy. It regenerates both and compares content
 * hashes before and after (so it also works outside a git checkout, such as a
 * scratch copy or a container build context).
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const GENERATED = ['src/api/generated', 'src/routeTree.gen.ts'];

function files(target: string): string[] {
  if (!existsSync(target)) return [];
  if (statSync(target).isFile()) return [target];
  return readdirSync(target).flatMap((name) => files(path.join(target, name)));
}

function snapshot(): Map<string, string> {
  const out = new Map<string, string>();
  for (const root of GENERATED) {
    for (const file of files(root)) {
      out.set(
        file.replaceAll('\\', '/'),
        createHash('sha256').update(readFileSync(file)).digest('hex'),
      );
    }
  }
  return out;
}

function run(label: string, command: string, args: string[]): void {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    shell: process.platform === 'win32',
    env: { ...process.env, CI: '1' },
  });
  if (result.status !== 0) {
    console.error(`gen:check: ${label} failed\n${result.stdout}\n${result.stderr}`);
    process.exit(2);
  }
}

const before = snapshot();
run('openapi-ts', 'npx', ['openapi-ts']);
// A production build regenerates the route tree as a side effect; the output directory is thrown away.
run('route tree', 'npx', [
  'vite',
  'build',
  '--outDir',
  'node_modules/.cache/gen-check',
  '--emptyOutDir',
]);
const after = snapshot();

const changed = new Set<string>();
for (const [file, hash] of after) if (before.get(file) !== hash) changed.add(file);
for (const file of before.keys()) if (!after.has(file)) changed.add(file);

if (changed.size > 0) {
  console.error(
    'gen:check: generated code is out of date. Run `npm run gen` and `npm run build`, then commit:',
  );
  for (const file of [...changed].sort()) console.error(`  ${file}`);
  process.exit(1);
}
console.log(`gen:check: ${before.size} generated files are current`);
