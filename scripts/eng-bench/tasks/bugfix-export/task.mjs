/**
 * Task 2 — a bug fix in an unfamiliar codebase, from a customer ticket, with
 * no failing test handed over.
 *
 * The seeded bug is keyset pagination on a non-unique key: `page()` resumes
 * at `createdAt > cursor`, so rows sharing a timestamp across a page boundary
 * are silently skipped. Bulk imports stamp a whole batch with one second, so
 * big imported accounts lose rows — the ticket's symptom. It is non-obvious
 * on purpose: the tempting one-character fix (`>=`) turns a missing-rows bug
 * into a duplicate-rows bug, and into an infinite loop when a tie group is
 * larger than a page. Only a compound cursor (timestamp + id, with a matching
 * sort) passes the hidden tests.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { copyDir, gitInit, gitChanged, runNodeTests, listFiles, testScripts } from '../../lib/util.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

export default {
  id: 'bugfix-export',
  title: 'Bug fix in an unfamiliar codebase',
  soft: false,

  setup(project) {
    copyDir(path.join(here, 'fixture'), project);
    gitInit(project);
  },

  prompt: [
    'Bug report from the finance team (ticket FIN-2291):',
    '',
    '> The nightly CSV export is missing transactions for some accounts. Account acct_4471 shows',
    '> 1,203 transactions in the admin UI (which uses store.count), but last night\'s export file had',
    '> 1,187 data rows. Smaller accounts look fine and nothing errors in the logs. It started around',
    '> the time we began onboarding customers through the bulk importer, but a few accounts that',
    '> never used the importer have also come up short once or twice.',
    '>',
    '> Expected: the export contains every transaction of the account exactly once, oldest first.',
    '',
    'This repository (ledger-export) is the code behind that export. Find the root cause and fix it',
    'properly. Keep the public API backwards compatible (TransactionStore and its methods, page(),',
    'iterateAccount, exportAccountCsv, importBatch). Add a regression test that would have caught it.',
  ].join('\n'),

  async grade({ project, check }) {
    const visible = runNodeTests(testScripts(project), { cwd: project });
    check('visible-tests-pass', visible.tests.length > 0 && visible.failed === 0 && visible.code === 0,
      `${visible.passed}/${visible.tests.length} passed`);

    const changed = gitChanged(project);
    check('regression-test-added', changed.some((f) => /(^|\/)test\/|\.test\.m?js$/.test(f)), changed.join(', '));
    check('fix-in-source', changed.some((f) => f.startsWith('src/')), changed.filter((f) => f.startsWith('src/')).join(', ') || 'no src/ change');

    const hiddenDir = path.join(project, '.bench-hidden');
    fs.mkdirSync(hiddenDir, { recursive: true });
    fs.copyFileSync(path.join(here, 'hidden', 'export.hidden.test.mjs'), path.join(hiddenDir, 'export.hidden.test.mjs'));
    const hidden = runNodeTests(['.bench-hidden/export.hidden.test.mjs'], { cwd: project, timeoutMs: 90_000 });
    const expected = [
      'ties across page boundaries are exported exactly once (several page sizes)',
      'a tie group larger than one page terminates and is complete',
      'export order is chronological',
      'a bulk-imported account exports every row (1,203 rows)',
      'rows inserted out of order still export once, in order',
      'page() contract is unchanged (cursor string, null at the end)',
      'distinct timestamps still paginate exactly (regression)',
    ];
    for (const name of expected) {
      const t = hidden.tests.find((x) => x.name === `hidden: ${name}`);
      check(`hidden: ${name}`, t?.ok === true, t ? '' : `did not report${hidden.timedOut ? ' (timed out)' : ''}`);
    }
    fs.rmSync(hiddenDir, { recursive: true, force: true });
    return { changedFiles: changed };
  },
};
