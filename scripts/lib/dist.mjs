/**
 * The engine bundle the tests import (`dist-test/test-exports.js`), with one override: set
 * `AICO_TEST_DIST` to a directory holding a `test-exports.js` to test a private build while
 * another agent or a watcher owns `dist-test`. A top-level await so a test can
 * `import { T } from './lib/dist.mjs'` like any other module.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const T = await import(process.env.AICO_TEST_DIST
  ? pathToFileURL(path.join(process.env.AICO_TEST_DIST, 'test-exports.js')).href
  : new URL('../../dist-test/test-exports.js', import.meta.url).href);
