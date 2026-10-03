/**
 * How a terminal tab's shell is started: which shell, and the arguments and
 * environment that load AICO's shell integration (terminal-integration.ts).
 *
 * Split from terminal.ts so the desktop test can launch a real shell through
 * exactly this code without Electron. It writes generated scripts into a
 * directory under AICO's store and nothing else — never the user's profile
 * or rc files (ADR 0019).
 *
 * @module desktop/electron/terminal-launch
 */

import fs from 'node:fs';
import path from 'node:path';
import { bashScript, powershellScript, shellKind, zshScripts } from '../shared/terminal-integration';

export function defaultShell(): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    const pwsh = ['C:\\Program Files\\PowerShell\\7\\pwsh.exe'].find(p => fs.existsSync(p));
    return pwsh ? { file: pwsh, args: ['-NoLogo'] } : { file: 'powershell.exe', args: ['-NoLogo'] };
  }
  return { file: process.env.SHELL || '/bin/bash', args: ['-l'] };
}

/**
 * Arguments and environment that load AICO's integration for this shell, or
 * the plain launch when the shell is not one we integrate (cmd.exe, fish …).
 * Scripts are (re)written into `dir` — generated text, never the user's files.
 */
export function integratedLaunch(shell: { file: string; args: string[] }, dir: string): { args: string[]; env: Record<string, string>; integration: boolean } {
  const kind = shellKind(shell.file);
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (kind === 'pwsh') {
      const file = path.join(dir, 'aico-integration.ps1');
      fs.writeFileSync(file, powershellScript());
      return { args: ['-NoLogo', '-NoExit', '-Command', `. '${file.replace(/'/g, "''")}'`], env: {}, integration: true };
    }
    if (kind === 'bash') {
      const file = path.join(dir, 'aico-integration.bash');
      fs.writeFileSync(file, bashScript());
      return { args: ['--rcfile', file.replace(/\\/g, '/'), '-i'], env: {}, integration: true };
    }
    if (kind === 'zsh') {
      const zdir = path.join(dir, 'zsh');
      fs.mkdirSync(zdir, { recursive: true });
      for (const [name, text] of Object.entries(zshScripts())) fs.writeFileSync(path.join(zdir, name), text);
      return { args: ['-l'], env: { ZDOTDIR: zdir, AICO_USER_ZDOTDIR: process.env.ZDOTDIR ?? '' }, integration: true };
    }
  } catch { /* an unwritable store: run the shell plainly rather than not at all */ }
  return { args: shell.args, env: {}, integration: false };
}

/**
 * Keep the directory a shell reports spelled the way AICO spelled it.
 *
 * Found live: on Windows the store can be under an 8.3 short path
 * (`C:\Users\SUHAIL~1\…`) while PowerShell reports the long one
 * (`C:\Users\Suhail Akhtar\…`), so a tab in the scratch workspace was not
 * recognised as being in it. Directories under the tab's starting folder are
 * rewritten back to that folder's spelling; anything else passes unchanged.
 */
export function respeller(given: string): (cwd: string) => string {
  let real = '';
  try { real = fs.realpathSync.native(given); } catch { return c => c; }
  const win = process.platform === 'win32';
  const norm = (s: string): string => { const u = s.replace(/[\\/]+$/, ''); return win ? u.replace(/\//g, '\\').toLowerCase() : u; };
  const r = norm(real);
  if (r === norm(given)) return c => c;
  const sep = win ? '\\' : '/';
  return (cwd) => {
    const n = norm(cwd);
    if (n === r) return given;
    if (n.startsWith(r + sep)) return given.replace(/[\\/]+$/, '') + cwd.replace(/[\\/]+$/, '').slice(r.length);
    return cwd;
  };
}
