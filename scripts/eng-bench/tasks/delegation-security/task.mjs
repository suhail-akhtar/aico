/**
 * Task 6 — a job big enough to split: five security findings in five
 * independent packages, with an audit report as the only brief.
 *
 * Two things are measured and only one is scored. The score is the result:
 * hidden tests per finding, each written to catch the plausible-but-wrong fix
 * as well as the missing one (a `startsWith(root)` check that a sibling
 * folder passes, a `timingSafeEqual` that throws on a short signature, an
 * open-redirect check a tab character defeats, an escaper that forgets
 * attributes). The other is *how* the work was delegated — the exact briefs
 * the parent wrote for its sub-agents and whether it checked their work —
 * which the runner pulls from the session logs for a person to review. The
 * prompt allows delegation without demanding it, so "chose not to" is a
 * recorded outcome too.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { copyDir, gitInit, gitChanged, runNodeTests, readText, listFiles } from '../../lib/util.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PACKAGES = ['safe-path', 'user-query', 'session-token', 'redirect-guard', 'html-render'];
const countTests = (text) => (text.match(/\b(test|it)\s*\(/g) ?? []).length;

export default {
  id: 'delegation-security',
  title: 'Delegation: five independent security fixes',
  soft: false,

  setup(project) {
    copyDir(path.join(here, 'fixture'), project);
    gitInit(project);
  },

  prompt: [
    'An external security review of this repository (platform-libs) is in AUDIT.md: five findings, one in each',
    'of the five packages under packages/. Fix all five, following the review board\'s requirements at the end',
    'of AUDIT.md, and add regression tests for each finding. Run the whole suite before you finish.',
    '',
    'The packages are independent of each other, so this splits cleanly; delegate to sub-agents where you judge',
    'it worthwhile, and check what they did before you report back.',
  ].join('\n'),

  async grade({ project, check }) {
    const testFiles = listFiles(path.join(project, 'packages')).filter((f) => /\.test\.m?js$/.test(f)).map((f) => `packages/${f}`);
    const all = runNodeTests(testFiles, { cwd: project });
    check('package-tests-pass', all.tests.length >= 14 && all.failed === 0 && all.code === 0, `${all.passed}/${all.tests.length} passed`);

    const hiddenDir = path.join(project, '.bench-hidden');
    fs.mkdirSync(hiddenDir, { recursive: true });
    fs.copyFileSync(path.join(here, 'hidden', 'security.hidden.test.mjs'), path.join(hiddenDir, 'security.hidden.test.mjs'));
    const hidden = runNodeTests(['.bench-hidden/security.hidden.test.mjs'], { cwd: project, timeoutMs: 90_000 });
    fs.rmSync(hiddenDir, { recursive: true, force: true });
    const loadError = hidden.tests.length === 0 ? (hidden.raw.match(/(SyntaxError|Error)[^\n]*/)?.[0] ?? 'no tests reported') : '';

    for (const pkg of PACKAGES) {
      const group = hidden.tests.filter((t) => t.name.startsWith(`hidden: ${pkg}:`));
      const failed = group.filter((t) => !t.ok).map((t) => t.name.replace(`hidden: ${pkg}: `, ''));
      check(`fixed: ${pkg}`, group.length >= 3 && failed.length === 0, loadError || failed.join('; '));
    }
    const token = readText(path.join(project, 'packages', 'session-token', 'index.js'));
    check('fixed: session-token uses a constant-time compare', /timingSafeEqual/.test(token));

    const fixtureRoot = path.join(here, 'fixture', 'packages');
    for (const pkg of PACKAGES) {
      const before = countTests(readText(path.join(fixtureRoot, pkg, 'index.test.js')));
      const dir = path.join(project, 'packages', pkg);
      const after = fs.existsSync(dir)
        ? fs.readdirSync(dir).filter((f) => /\.test\.m?js$/.test(f)).reduce((n, f) => n + countTests(readText(path.join(dir, f))), 0)
        : 0;
      check(`regression-test: ${pkg}`, after > before, `${before} → ${after} tests`);
    }
    return { changedFiles: gitChanged(project) };
  },
};
