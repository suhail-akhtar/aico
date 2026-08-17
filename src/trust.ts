import { readFile, writeFile, mkdir } from 'fs/promises';
import path from 'path';

interface TrustData {
  trustedTools?: string[];
  trustAll?: boolean;
}

export async function loadTrust(cwd: string): Promise<'all' | Set<string>> {
  const filePath = path.join(cwd, '.aico', 'trust.json');
  try {
    const text = await readFile(filePath, 'utf8');
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
  const dir = path.join(cwd, '.aico');
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, 'trust.json');
  const data: TrustData = {
    trustAll: trust === 'all',
    trustedTools: trust instanceof Set ? [...trust] : [],
  };
  await writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}
