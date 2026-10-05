/**
 * One entry point for parsing any supported file, and the path rules that do
 * not need its content: language by extension, test files, entry points.
 *
 * @module codegraph/parse
 */

import type { Lang, ParsedFile } from '../types.js';
import { parseGo } from './go.js';
import { parseJs } from './js.js';
import { parseCSharp, parseJvm, parsePhp, parseRuby, parseRust } from './others.js';
import { parsePython } from './python.js';

const BY_EXT: Record<string, Lang> = {
  '.ts': 'ts', '.tsx': 'ts', '.mts': 'ts', '.cts': 'ts',
  '.js': 'js', '.jsx': 'js', '.mjs': 'js', '.cjs': 'js',
  '.py': 'py', '.pyi': 'py',
  '.go': 'go',
  '.java': 'java',
  '.kt': 'kotlin', '.kts': 'kotlin',
  '.cs': 'cs',
  '.php': 'php',
  '.rb': 'rb', '.rake': 'rb',
  '.rs': 'rs',
};

export const SOURCE_EXTENSIONS = Object.keys(BY_EXT).map(e => e.slice(1));

export function langOf(file: string): Lang | undefined {
  const dot = file.lastIndexOf('.');
  if (dot < 0) return undefined;
  return BY_EXT[file.slice(dot).toLowerCase()];
}

export function parseSource(source: string, lang: Lang): ParsedFile {
  switch (lang) {
    case 'ts':
    case 'js': return parseJs(source, lang);
    case 'py': return parsePython(source);
    case 'go': return parseGo(source);
    case 'java':
    case 'kotlin': return parseJvm(source, lang);
    case 'cs': return parseCSharp(source);
    case 'php': return parsePhp(source);
    case 'rb': return parseRuby(source);
    case 'rs': return parseRust(source);
  }
}

/** Test files by the conventions of each ecosystem. */
export function isTestPath(path: string): boolean {
  const p = path.toLowerCase();
  if (/(^|\/)(__tests__|__test__|tests?|spec|specs|e2e|testing)\//.test(p)) return true;
  const base = p.slice(p.lastIndexOf('/') + 1);
  return /\.(test|spec|e2e)\.[a-z]+$/.test(base)
    || /_test\.go$/.test(base)
    || /^test_.*\.py$/.test(base) || /_test\.py$/.test(base) || base === 'conftest.py'
    || /(test|tests|spec)\.(java|kt|cs)$/.test(base)
    || /_spec\.rb$/.test(base) || /_test\.rb$/.test(base);
}

/** Entry points recognisable from the path alone (framework conventions). */
export function entryFromPath(path: string): string | undefined {
  const p = path.toLowerCase();
  const base = p.slice(p.lastIndexOf('/') + 1);
  // Next.js app router and pages router.
  if (/(^|\/)app\/(.*\/)?(page|layout|route|loading|error|not-found|template|default)\.(tsx?|jsx?|mdx)$/.test(p)) return base.startsWith('route') ? 'route' : 'page';
  // `pages/` only at a project or package root (or under its src/): a `pages` folder deep in an
  // app is just a folder of components.
  if (/^((apps|packages)\/[^/]+\/)?(src\/)?pages\/.+\.(tsx?|jsx?)$/.test(p) && !/\/_(app|document)\./.test(p)) return 'page';
  if (/(^|\/)(middleware|instrumentation)\.(ts|js)$/.test(p)) return 'framework';
  // Python.
  if (base === '__main__.py' || base === 'manage.py' || base === 'wsgi.py' || base === 'asgi.py') return 'main';
  // Rust.
  if (/(^|\/)src\/main\.rs$/.test(p) || /(^|\/)src\/bin\/[^/]+\.rs$/.test(p)) return 'main';
  if (/(^|\/)src\/lib\.rs$/.test(p)) return 'library';
  // PHP, Ruby.
  if (/(^|\/)public\/index\.php$/.test(p) || base === 'artisan') return 'main';
  if (base === 'config.ru' || /(^|\/)config\/routes\.rb$/.test(p)) return 'routes';
  // C#.
  if (base === 'program.cs') return 'main';
  return undefined;
}
