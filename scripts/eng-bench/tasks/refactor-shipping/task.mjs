/**
 * Task 3 — refactor without breaking: a 120-line carrier if/else god
 * function becomes a Strategy registry, with behaviour pinned exactly.
 *
 * Behaviour is checked by characterization, not by the visible tests: 800
 * seeded orders (unknown carriers, mixed case, invalid weights, Saturday
 * pickups, rounding edges, international/remote combinations) are run
 * through the *original* module and the refactored one and must match
 * deep-equal, errors included. The fixture has real traps a careless refactor
 * falls into — weight validation happens before carrier dispatch, FedEx fuel
 * is computed on the unrounded base, FREESHIP's discount is left unrounded.
 *
 * Structure is checked mechanically: a module per carrier exposing quote(),
 * a dispatcher with no carrier names in it, an extension point that works,
 * and the duplicated insurance rule existing once.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { copyDir, gitInit, gitChanged, runNodeTests, listFiles, testScripts } from '../../lib/util.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

export default {
  id: 'refactor-shipping',
  title: 'Refactor without breaking (Strategy pattern)',
  soft: false,

  setup(project) {
    copyDir(path.join(here, 'fixture'), project);
    gitInit(project);
  },

  prompt: [
    'src/shipping.js has grown into one long calculateShipping function that every carrier change has to',
    'touch; it keeps causing merge conflicts and regressions. Refactor it to the Strategy pattern:',
    '',
    '- one strategy module per carrier under src/carriers/ (ups, fedex, dhl, usps), each exporting an object',
    '  with a quote(order) method that returns the complete quote object;',
    '- src/shipping.js keeps exporting calculateShipping(order) and becomes a thin dispatcher with no',
    '  carrier-specific logic in it;',
    '- src/shipping.js also exports registerCarrier(name, strategy) so a new carrier can be added without',
    '  editing calculateShipping; calculateShipping returns a registered strategy\'s quote unchanged;',
    '- rules that several carriers share (for example the declared-value insurance) live in one shared',
    '  helper instead of being copied into each carrier.',
    '',
    'Behaviour must not change at all: other teams depend on the exact numbers, rounding, notes and error',
    'messages for every input, valid or not. The existing tests must keep passing; add tests where they help',
    'you prove that behaviour is unchanged.',
  ].join('\n'),

  async grade({ project, check }) {
    const visible = runNodeTests(testScripts(project), { cwd: project });
    check('visible-tests-pass', visible.tests.length >= 8 && visible.failed === 0 && visible.code === 0,
      `${visible.passed}/${visible.tests.length} passed`);
    const changed = gitChanged(project);
    check('tests-added', changed.some((f) => /(^|\/)test\/|\.test\.m?js$/.test(f)), changed.join(', '));

    const hiddenDir = path.join(project, '.bench-hidden');
    fs.mkdirSync(hiddenDir, { recursive: true });
    fs.copyFileSync(path.join(here, 'hidden', 'refactor.hidden.test.mjs'), path.join(hiddenDir, 'refactor.hidden.test.mjs'));
    fs.copyFileSync(path.join(here, 'fixture', 'src', 'shipping.js'), path.join(hiddenDir, 'original-shipping.mjs'));
    const hidden = runNodeTests(['.bench-hidden/refactor.hidden.test.mjs'], { cwd: project, timeoutMs: 90_000 });
    const expected = [
      'behaviour is identical to the original for 800 generated orders',
      'registerCarrier adds a carrier without editing calculateShipping',
      'calculateShipping is a thin dispatcher with no carrier logic',
      'one strategy module with quote() per carrier under src/carriers',
      'shared insurance rule is not copied per carrier',
    ];
    // A module that fails to import fails every hidden test with one cause; say so.
    const importError = hidden.tests.length === 0 ? hidden.raw.match(/(SyntaxError|Error)[^\n]*/)?.[0] ?? 'no tests reported' : '';
    for (const name of expected) {
      const t = hidden.tests.find((x) => x.name === `hidden: ${name}`);
      check(`hidden: ${name}`, t?.ok === true, t ? (t.ok ? '' : failureDetail(hidden.raw, name)) : importError);
    }
    fs.rmSync(hiddenDir, { recursive: true, force: true });
    return { changedFiles: changed };
  },
};

function failureDetail(tap, name) {
  const i = tap.indexOf(`hidden: ${name}`);
  if (i < 0) return '';
  const m = tap.slice(i, i + 1500).match(/error: \|?-?\s*([^\n]+(?:\n\s{4,}[^\n]+){0,2})/);
  return m ? m[1].replace(/\s+/g, ' ').slice(0, 300) : '';
}
