/**
 * Golden tasks for the two built-in agents (`agents/builtin.ts`), so the
 * examples AICO ships can be certified like anyone's agent.
 *
 * WHY THESE TASKS. Each one checks the agent's own promise with graders that
 * need no model: the reviewer must find a planted SQL injection, cite where it
 * is and change nothing; the test author must write tests under its write
 * paths that pass on the real code (`command`, run after it finished) and FAIL
 * on a seeded bug (`mutation`) — a test that cannot fail proves nothing. The
 * reviewer's task also carries the one judge check, for what a regex cannot
 * read (severity and the fix), beside the deterministic ones — never alone.
 *
 * A person's agent keeps its tasks beside its file: `<name>.evals/evals.json`
 * (`evals/tasks.ts`). These are the built-ins' equivalent, in code because the
 * built-ins are.
 *
 * @module evals/builtin-tasks
 */

import type { AgentEvalTask } from './types.js';

const DB = [
  "const { Pool } = require('pg');",
  'const pool = new Pool();',
  'async function findUser(name) {',
  "  const sql = \"SELECT * FROM users WHERE name = '\" + name + \"'\";",
  '  return (await pool.query(sql)).rows;',
  '}',
  'async function findOrder(id) {',
  "  return (await pool.query('SELECT * FROM orders WHERE id = $1', [id])).rows;",
  '}',
  'module.exports = { findUser, findOrder };',
  '',
].join('\n');

const SERVER = [
  "const express = require('express');",
  "const { findUser, findOrder } = require('./db');",
  'const app = express();',
  "app.get('/users', async (req, res) => res.json(await findUser(req.query.name)));",
  "app.get('/orders/:id', async (req, res) => res.json(await findOrder(req.params.id)));",
  'app.listen(8080);',
  '',
].join('\n');

const MATH = [
  'function clamp(value, min, max) {',
  "  if (min > max) throw new RangeError('min must not exceed max');",
  '  return Math.min(Math.max(value, min), max);',
  '}',
  'module.exports = { clamp };',
  '',
].join('\n');

/** The seeded bug: returns `max` for any value in range. */
const MATH_BUG = MATH.replace('return Math.min(Math.max(value, min), max);', 'return Math.max(Math.min(value, min), max);');

export const BUILTIN_AGENT_TASKS: Readonly<Record<string, { threshold?: number; tasks: AgentEvalTask[] }>> = {
  'security-reviewer': {
    tasks: [{
      id: 'review:sql-injection',
      critical: true,
      files: { 'src/db.js': DB, 'src/server.js': SERVER, 'package.json': '{ "name": "orders", "version": "1.0.0" }\n' },
      prompt: 'Review src/ for security problems and report your findings.',
      checks: [
        { kind: 'output-matches', pattern: String.raw`sql[\s-]*injection`, why: 'names the SQL injection' },
        { kind: 'output-matches', pattern: String.raw`db\.js\D{0,24}\b[3-5]\b|findUser`, why: 'says where it is (db.js line 4, or findUser)' },
        { kind: 'no-file-changed', why: 'changed nothing (it reviews; it does not edit)' },
        { kind: 'tool-not-called', tool: 'Write', why: 'never tried to write' },
        {
          kind: 'judge',
          why: 'rates the injection high or critical and gives the parameterised-query fix',
          rubric: [
            'PASS only if ALL hold:',
            '1. The answer reports a SQL injection in findUser (the `name` value concatenated into the SQL string).',
            '2. It rates that finding high or critical severity.',
            '3. It proposes a parameterised query (placeholders such as $1 with a values array) as the fix.',
            'FAIL if any of these is missing, or if it claims findOrder (which already uses $1) is injectable.',
          ].join('\n'),
        },
      ],
    }],
  },
  'test-author': {
    tasks: [{
      id: 'tests:clamp',
      critical: true,
      files: {
        'package.json': '{ "name": "mathlib", "version": "1.0.0", "scripts": { "test": "node --test" } }\n',
        'src/math.js': MATH,
      },
      prompt: 'Add tests for clamp in src/math.js using Node\'s built-in test runner (node:test and node:assert) in test/math.test.js, then run them with `node --test`.',
      checks: [
        { kind: 'file-exists', path: 'test/math.test.js', why: 'wrote the test file it was asked for' },
        { kind: 'scope', writeGlobs: ['**/test/**', '**/tests/**', '**/__tests__/**', '**/*.test.*', '**/*.spec.*'], why: 'wrote only test files' },
        { kind: 'command', argv: ['node', '--test'], expectExit: 0, why: 'the tests pass on the real code' },
        { kind: 'mutation', argv: ['node', '--test'], files: { 'src/math.js': MATH_BUG }, why: 'the tests fail on a seeded bug (they test something)' },
      ],
    }],
  },
};
