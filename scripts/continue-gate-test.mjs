/**
 * The continue gate recognises "shall I proceed?" and nothing else: a real
 * question must still reach the person, and a person who asked for check-ins
 * keeps them (src/continue-gate.ts).
 */
import './lib/test-home.mjs';
import * as T from '../dist-test/test-exports.js';

let passed = 0, failed = 0;
const assert = (c, m) => { if (c) { passed++; console.log(`  ok    ${m}`); } else { failed++; console.log(`  FAIL  ${m}`); } };

for (const t of [
  'Phase 2 is done: the tab strip and address bar work.\n\nShall I proceed to phase 3 (downloads and history)?',
  'That covers the renderer. Would you like me to continue with the networking layer?',
  'All set. Let me know if you would like me to move on to the settings pages.',
  'I am ready to proceed with the next milestone when you are.',
  'Waiting for your go-ahead to start phase 4.',
]) assert(T.asksPermissionToContinue(t), `permission to carry on is recognised: "${t.slice(-50).replace(/\n/g, ' ')}"`);

for (const t of [
  'Which database should the browser store history in — SQLite or IndexedDB?',
  'I need the API key for the search provider before I can wire it. What is it?',
  'Done. All five phases are built, tested and committed.',
  'Should I use TypeScript or JavaScript for the preload script?',
  '',
]) assert(!T.asksPermissionToContinue(t), `a real question or a finished report is not matched: "${t.slice(0, 50).replace(/\n/g, ' ')}"`);

assert(!T.asksPermissionToContinue('Shall I proceed?' + ' Here is the report of the work done so far, in detail.'.repeat(30)), 'a question far from the end of a long report is not the last word');
assert(T.wantsCheckIns(['Build it, but ask me before each phase']), 'a request for check-ins is honoured');
assert(!T.wantsCheckIns(['do it end to end']), '"end to end" is not a request for check-ins');
assert(/next phase now/.test(T.CONTINUE_NUDGE) && /cannot be inferred/.test(T.CONTINUE_NUDGE), 'the nudge says to continue and when to stop');

console.log(`\ncontinue-gate: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
