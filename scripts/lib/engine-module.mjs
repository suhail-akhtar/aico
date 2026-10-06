/**
 * Load a TypeScript module of the engine from a plain-node script, without a
 * prior `npm run build`.
 *
 * Why this exists: `scripts/validate-template.mjs` and the rot check
 * (`scripts/templates-live.mjs`) must use the *engine's own* manifest validator,
 * toolchain probes and Docker argv builder (ADR 0031), not a second copy that
 * drifts. The engine is TypeScript; the scripts are `.mjs`. esbuild (already a
 * dependency of tsup and the desktop build) bundles the one module and its
 * relative imports to a temp file, with `node_modules` packages left external.
 *
 * What it does not do: cache across runs, or type-check — `npm run typecheck`
 * owns that.
 */
import { build } from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Bundle `src/<rel>` (e.g. `apps/templates.ts`) and import it. */
export async function loadEngineModule(rel) {
  const out = path.join(fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'aico-engine-mod-')), `${path.basename(rel, '.ts')}.mjs`);
  await build({
    entryPoints: [path.join(root, 'src', rel)],
    outfile: out, bundle: true, platform: 'node', format: 'esm', target: 'node22', packages: 'external',
    logLevel: 'silent', jsx: 'transform', jsxFactory: 'React.createElement', jsxFragment: 'React.Fragment',
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  });
  const mod = await import(pathToFileURL(out).href);
  // The bundle is read; the file can go. A handle on Windows may linger, which is harmless.
  try { fs.rmSync(path.dirname(out), { recursive: true, force: true }); } catch { /* temp */ }
  return mod;
}
