// Reference regression test (grader self-test only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as mod from './index.js';

test('html-render exports its API', () => {
  assert.ok(Object.keys(mod).length > 0);
});
