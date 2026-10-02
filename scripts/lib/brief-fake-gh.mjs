/**
 * A recorded `gh` (and a scripted `git`) for the morning brief's collectors.
 *
 * Why: the collectors' whole job is reading `gh` output correctly, and the
 * real `gh` needs a network, a sign-in and a repository whose state changes
 * daily. This answers each read the collectors make from the JSON files in
 * `scripts/fixtures/brief-gh/`, records every call (so a test can prove that
 * nothing but reads was ever run), and refuses any command it does not know.
 *
 * Used by scripts/brief-test.mjs and the desktop live check
 * (desktop/scripts/brief-live.mjs).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'brief-gh');

/**
 * @param {{ signedIn?: boolean, missing?: boolean, files?: Record<string,string>, git?: Record<string,{code?:number,stdout?:string}> }} [opts]
 *   `files` overrides a fixture's text by name (e.g. `{ runs: '[...]' }`); `git` answers git by its joined args.
 */
export function fakeRunner(opts = {}) {
  const calls = [];
  const read = (name) => opts.files?.[name] ?? fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8');
  const run = async (cmd, args, cwd) => {
    calls.push({ cmd, args: [...args], cwd });
    if (cmd === 'git') {
      const hit = opts.git?.[args.join(' ')];
      return hit ? { code: hit.code ?? 0, stdout: hit.stdout ?? '', stderr: '' } : { code: 128, stdout: '', stderr: 'not a git repository' };
    }
    if (opts.missing) return { code: -1, stdout: '', stderr: '', missing: true };
    const [a, b] = args;
    if (a === 'auth' && b === 'status') return { code: opts.signedIn === false ? 1 : 0, stdout: '', stderr: '' };
    if (opts.signedIn === false) return { code: 1, stdout: '', stderr: 'gh auth login required' };
    let name;
    if (a === 'repo' && b === 'view') name = 'repo-view';
    else if (a === 'pr' && b === 'list') name = args.includes('review-requested:@me') ? 'pr-review' : 'pr-mine';
    else if (a === 'issue' && b === 'list') name = 'issues';
    else if (a === 'run' && b === 'list') name = 'runs';
    if (!name) return { code: 1, stdout: '', stderr: `fake gh: no fixture for ${args.join(' ')}` };
    return { code: 0, stdout: read(name), stderr: '' };
  };
  return { run, calls };
}

/** The read-only `gh` subcommands the collectors may use. Anything else in `calls` is a bug. */
export const GH_READS = new Set(['auth status', 'repo view', 'pr list', 'issue list', 'run list']);
