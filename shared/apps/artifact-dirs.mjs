/**
 * The one list of directories an app never copies, lists or ships.
 *
 * Why this exists: eight places (the template copy, the copy walk,
 * `apps/duplicate`, the Apps file tree, the file route, the bound-session
 * listing, the npm package filter, the desktop package filter) each hand-wrote
 * Node's artefact directories, and every new stack (Python's `.venv`, Java's
 * `target`, .NET's `bin`/`obj`, PHP's `vendor`) would have had to be added to
 * all eight — missing one ships a 400 MB virtualenv in an installer. They now
 * import this.
 *
 * Why plain JavaScript beside a `.d.mts`: `tsup.config.ts`, the desktop build
 * script and the rot check run before (or without) the TypeScript build, and
 * the engine imports the same file, so there is nothing to drift.
 *
 * What it deliberately does not do: decide per directory whether it is
 * "really" an artefact. Names like `bin`, `build` and `vendor` can be source in
 * some projects; a template says so with `keepDirs` in its manifest, and the
 * package filter reads that per template.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Directory names that are always dependencies, caches or build output. */
export const ARTIFACT_DIRS = Object.freeze([
  'node_modules', '.next', '.next-dev', '.astro', '.expo', 'dist', 'web-build', 'coverage',
  '.turbo', 'out',
  '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox',
  'target', 'bin', 'obj', '.gradle', 'build', 'vendor',
  '.idea', '.vs', '.terraform', '.cache',
]);

/**
 * The subset that is only ever installed dependencies: the file route refuses
 * to read inside these (huge, never what the person meant), while build output
 * such as `dist/` stays readable.
 */
export const DEPENDENCY_DIRS = Object.freeze([
  'node_modules', '.venv', 'venv', '__pycache__', 'vendor', '.gradle', '.tox',
]);

/** File names (not directories) that are local state, never source. */
export const ARTIFACT_FILES = Object.freeze([
  'data.sqlite', 'data.sqlite-wal', 'data.sqlite-shm', 'package-lock.json.bak',
]);

/**
 * Names the nine Node templates always ignored in addition: a scratch `data/`
 * directory and the local env files. A template with a `toolchain` keeps
 * `data/` (a legitimate source directory in Go and Java projects) unless it is
 * listed in its own `artifactDirs`.
 */
export const LEGACY_NODE_EXTRA = Object.freeze(['data', '.env', '.env.local']);

/** Paths (relative, forward slashes) that are artefacts as a path rather than a name. */
export const ARTIFACT_PATHS = Object.freeze(['storage/logs']);

/**
 * Whether one path segment (a base name) is an artefact.
 *
 * @param {string} name
 * @param {{ keep?: readonly string[], extra?: readonly string[] }} [opts]
 */
export function isArtifactName(name, opts = {}) {
  if (opts.keep && opts.keep.includes(name)) return false;
  if (ARTIFACT_DIRS.includes(name)) return true;
  if (ARTIFACT_FILES.includes(name)) return true;
  if (name.endsWith('.tsbuildinfo')) return true;
  if (opts.extra && opts.extra.includes(name)) return true;
  return false;
}

/**
 * Whether a relative path has any artefact segment (or artefact path prefix).
 *
 * @param {string} rel
 * @param {{ keep?: readonly string[], extra?: readonly string[] }} [opts]
 */
export function hasArtifactSegment(rel, opts = {}) {
  const norm = rel.split(path.sep).join('/').replace(/^\.\//, '');
  if (ARTIFACT_PATHS.some(p => norm === p || norm.startsWith(`${p}/`) || norm.includes(`/${p}/`) || norm.endsWith(`/${p}`))) return true;
  return norm.split('/').some(seg => isArtifactName(seg, opts));
}

/**
 * A `filter` for `fs.cp` / `fs.cpSync` that packages the templates directory:
 * drops artefacts, honouring each template's own `keepDirs` and `artifactDirs`.
 *
 * @param {string} templatesRoot absolute or relative path of the `templates` directory
 */
export function templatePackageFilter(templatesRoot) {
  const root = path.resolve(templatesRoot);
  const cache = new Map();
  const optionsFor = (id) => {
    if (cache.has(id)) return cache.get(id);
    let opts = {};
    try {
      const m = JSON.parse(fs.readFileSync(path.join(root, id, 'template.json'), 'utf8'));
      opts = {
        keep: Array.isArray(m.keepDirs) ? m.keepDirs : [],
        extra: Array.isArray(m.artifactDirs) ? m.artifactDirs : [],
        // Node templates (no `toolchain`) have always dropped `data`.
        legacy: !m.toolchain,
      };
    } catch { /* no manifest yet: be strict */ }
    cache.set(id, opts);
    return opts;
  };
  return (src) => {
    const rel = path.relative(root, path.resolve(src)).split(path.sep).join('/');
    if (!rel || rel.startsWith('..')) return true;
    const [id, ...rest] = rel.split('/');
    if (rest.length === 0) return true;
    const o = optionsFor(id);
    const inner = rest.join('/');
    if (hasArtifactSegment(inner, o)) return false;
    if (o.legacy && rest.some(seg => seg === 'data')) return false;
    return true;
  };
}
