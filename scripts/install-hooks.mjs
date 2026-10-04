#!/usr/bin/env node
/**
 * Point this clone's git at the repository's own hooks in `.githooks/`.
 *
 * The hooks are the cheap half of "enforce in the loop, not in the prompt"
 * applied to contributors: `commit-msg` refuses AI attribution before a commit
 * exists, `pre-push` runs `check-standards --fast` over what is about to
 * leave the machine, and `pre-commit` runs the security scan over the staged
 * files (scripts/security-scan.mjs --staged, ADR 0026). CI runs the full check again, so a skipped hook is caught
 * later rather than never — but later means after the push, which for an
 * attribution trailer meant a history rewrite.
 *
 * `core.hooksPath` rather than copying into `.git/hooks`: the hooks stay
 * versioned, and an update to them needs no reinstall.
 *
 * Safe to run from `npm install` (scripts/prepare.mjs calls it): it never
 * fails, does nothing outside a git work tree or in CI, and never replaces a
 * hooksPath someone else set (husky, a personal hooks directory) unless told
 * to with --force.
 *
 *   node scripts/install-hooks.mjs            install (idempotent)
 *   node scripts/install-hooks.mjs --check    report, change nothing
 *   node scripts/install-hooks.mjs --uninstall
 *   node scripts/install-hooks.mjs --force    replace another hooksPath
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const args = new Set(process.argv.slice(2));
const quiet = args.has('--quiet');
const say = (msg) => { if (!quiet) console.log(`install-hooks: ${msg}`); };
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOKS = '.githooks';

function git(...a) {
  return execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

try {
  if (process.env.CI && !args.has('--check')) { say('CI — skipped'); process.exit(0); }
  let inside = false;
  try { inside = git('rev-parse', '--is-inside-work-tree') === 'true'; } catch { /* not a repo, or no git */ }
  if (!inside || !fs.existsSync(path.join(root, HOOKS))) { say('not a git work tree with .githooks/ — nothing to do'); process.exit(0); }

  let current = '';
  try { current = git('config', '--local', '--get', 'core.hooksPath'); } catch { /* unset */ }

  if (args.has('--check')) {
    say(current === HOOKS ? `installed (core.hooksPath=${HOOKS})` : `NOT installed (core.hooksPath=${current || 'unset'}) — run: node scripts/install-hooks.mjs`);
    process.exit(0);
  }
  if (args.has('--uninstall')) {
    if (current === HOOKS) { git('config', '--local', '--unset', 'core.hooksPath'); say('removed'); }
    else say('not installed — nothing to remove');
    process.exit(0);
  }
  if (current && current !== HOOKS && !args.has('--force')) {
    say(`core.hooksPath is already "${current}" — left alone. Re-run with --force to use ${HOOKS}/, or call scripts/check-standards.mjs from your own hooks.`);
    process.exit(0);
  }
  // A checkout on Windows, or a zip, can lose the executable bit; git then
  // skips the hook with only a hint. Restore it where the filesystem has one.
  for (const name of fs.readdirSync(path.join(root, HOOKS))) {
    try { fs.chmodSync(path.join(root, HOOKS, name), 0o755); } catch { /* best effort */ }
  }
  if (current !== HOOKS) git('config', '--local', 'core.hooksPath', HOOKS);
  say(`installed — core.hooksPath=${HOOKS} (pre-commit, commit-msg, pre-push)`);
} catch (err) {
  // Never fail an install over hooks.
  say(`skipped (${err.message.split('\n')[0]})`);
}
process.exit(0);
