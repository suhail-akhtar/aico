/**
 * The terminal's remembered "always allow" answers, per project.
 *
 * These used to live in the project's own `.aico/trust.json`, which is the one
 * place a cloned repository can write: a repo that shipped
 * `{"trustAll": true}` had every tool auto-approved in the terminal, with no
 * prompt, the first time anyone ran `aico` in it. They now live in the user's
 * store, keyed by project directory, and a project's `.aico/trust.json` is
 * ignored entirely.
 *
 * Not to be confused with workspace trust (`workspace-trust.ts`), which decides
 * whether a project's settings may run commands at all.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import crypto from 'crypto';
import path from 'path';
import { aicoHome } from './home.js';

interface TrustData {
  trustedTools?: string[];
  trustAll?: boolean;
}

/** Where one project's answers are kept: under the user's store, never in the project. */
function trustFile(cwd: string): string {
  const resolved = path.resolve(cwd);
  const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  const id = crypto.createHash('sha256').update(key).digest('hex').slice(0, 24);
  return path.join(aicoHome(), 'tool-trust', `${id}.json`);
}

export async function loadTrust(cwd: string): Promise<'all' | Set<string>> {
  try {
    const text = await readFile(trustFile(cwd), 'utf8');
    const data = JSON.parse(text) as TrustData;
    if (data.trustAll) return 'all';
    return new Set(data.trustedTools ?? []);
  } catch {
    return new Set();
  }
}

export async function saveTrust(
  cwd: string,
  trust: 'all' | 'none' | Set<string>,
): Promise<void> {
  const filePath = trustFile(cwd);
  await mkdir(path.dirname(filePath), { recursive: true });
  const data: TrustData = {
    trustAll: trust === 'all',
    trustedTools: trust instanceof Set ? [...trust] : [],
  };
  await writeFile(filePath, JSON.stringify({ path: path.resolve(cwd), ...data }, null, 2), 'utf8');
}
