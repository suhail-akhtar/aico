/**
 * The shell the command tools actually get, exercised on this machine.
 *
 * This exists because the bug it guards was invisible to every other kind of
 * test. `Bash` and `Terminal` spawned `cmd.exe` on Windows, the typechecker was
 * happy, the unit tests were happy, and a model asking for `ls -la vendor/` got
 * *'ls' is not recognized as an internal or external command* — then tried
 * `| head -50` and got it again. Nothing in the codebase said which shell was
 * running, so nothing could contradict a tool named `Bash`.
 *
 * So this runs real commands through both tools and checks the answers.
 *
 * Run: node scripts/shell-live.mjs
 * Needs: npx tsup src/test-exports.ts --format esm --outDir dist-test --target node22
 */

// A store of this process's own — nothing below may touch ~/.aico. Must stay first.
import './lib/test-home.mjs';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  detectShell, resetShellChoiceForTest, bash, terminal, closeAllTerminals,
  runInContext,
} from '../dist-test/test-exports.js';

let passed = 0, failed = 0;
const fails = [];
function check(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; fails.push(label); console.log(`  ✗ ${label}`); }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-shell-live-'));
fs.mkdirSync(path.join(dir, 'vendor'));
fs.writeFileSync(path.join(dir, 'vendor', 'one.txt'), 'first\n');
fs.writeFileSync(path.join(dir, 'vendor', 'two.txt'), 'second\n');

try {
  console.log('\nSHELL — the one the tools actually get\n');

  resetShellChoiceForTest();
  const shell = detectShell();
  console.log(`  … chose ${shell.kind} at ${shell.command}\n`);

  check(
    ['posix', 'git-bash', 'powershell', 'cmd'].includes(shell.kind),
    `a shell was chosen (${shell.kind})`,
  );
  check(
    shell.describe.length > 10,
    'and it describes itself for the prompt',
  );
  /*
    The description has to be *true*, which is the part that would otherwise
    rot. A POSIX shell must not warn that POSIX tools are missing, and a
    non-POSIX one must warn — the whole point is that the model is told
    correctly rather than told something.
  */
  const posix = shell.kind === 'posix' || shell.kind === 'git-bash';
  check(
    posix !== /NOT available/.test(shell.describe),
    'the description agrees with the shell it describes',
  );

  await runInContext({ cwd: dir }, async () => {
    // ── one-shot: the exact command from the failing transcript ───────
    const listing = await bash({ command: 'ls -la vendor/' });
    if (posix) {
      check(
        listing.exit_code === 0 && /one\.txt/.test(listing.stdout),
        `Bash: "ls -la vendor/" works (${JSON.stringify((listing.stdout || listing.stderr).trim().slice(0, 60))})`,
      );
      const piped = await bash({ command: 'ls vendor/ | head -1' });
      check(
        piped.exit_code === 0 && piped.stdout.trim() === 'one.txt',
        'Bash: a pipe into head works',
      );
    } else {
      // Not a failure of the product — a machine without Git Bash. What must
      // hold is that the model was *told*, which is checked above.
      console.log('  … no POSIX shell here; skipping the ls assertions');
    }

    check(
      (await bash({ command: 'echo hello' })).stdout.trim() === 'hello',
      'Bash: echo round-trips whatever the shell is',
    );

    const failing = await bash({ command: 'exit 3' });
    check(failing.exit_code === 3, `Bash: a non-zero exit is reported (${failing.exit_code})`);

    // Quoting is where `windowsVerbatimArguments` used to be wrong for bash.
    const quoted = await bash({ command: 'echo "a b" && echo \'c d\'' });
    check(
      /a b/.test(quoted.stdout) && (!posix || /c d/.test(quoted.stdout)),
      `Bash: quotes survive the spawn (${JSON.stringify(quoted.stdout.trim().slice(0, 30))})`,
    );

    // ── the persistent shell: state, exit codes, cwd ──────────────────
    const first = await terminal({ command: "echo one" });
    check(first.output.includes('one'), 'Terminal: a command returns its output');
    check(first.exit_code === 0, `Terminal: exit code comes back (${first.exit_code})`);
    check(
      typeof first.cwd === 'string' && first.cwd.length > 0,
      `Terminal: the working directory comes back (${first.cwd})`,
    );

    /*
      The marker line is the part that breaks silently when the shell changes.
      With Git Bash preferred, a `%ERRORLEVEL%` marker would print literally,
      never match, and every command would report a timeout — so a *second*
      command in the same shell is the real check.
    */
    const second = await terminal({ command: 'cd vendor' });
    check(
      second.cwd.toLowerCase().includes('vendor'),
      `Terminal: cd is remembered between calls (${second.cwd})`,
    );

    const third = await terminal({ command: 'echo still-here' });
    check(
      third.output.includes('still-here') && third.exit_code === 0,
      'Terminal: the shell survives to a third command',
    );

    /*
      `exit` kills the shell, by definition — so the contract under test is not
      the exit code it reports (there is no shell left to ask) but that the next
      command still works. An earlier version of this asserted the code and was
      asserting the wrong thing.
    */
    await terminal({ command: 'exit 3' });
    const after = await terminal({ command: 'echo recovered' });
    check(
      after.output.includes('recovered'),
      'Terminal: a shell killed by `exit` is replaced rather than wedged',
    );
    check(
      after.cwd.length > 0,
      `Terminal: and the replacement reports its directory (${after.cwd})`,
    );
  });
} catch (err) {
  failed += 1;
  fails.push(`threw: ${err?.stack ?? err}`);
  console.log(`\n  ✗ ${err?.stack ?? err}`);
} finally {
  try { closeAllTerminals(); } catch { /* nothing open */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* windows holds handles */ }
}

console.log(`\nSHELL: ${passed} passed, ${failed} failed`);
if (fails.length) {
  console.log('\nFailures:');
  for (const f of fails) console.log(`  - ${f}`);
}
process.exit(failed > 0 ? 1 : 0);
