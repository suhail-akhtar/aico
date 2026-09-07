import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { run } from '../src/cli.js';
import { countText, renderTable } from '../src/commands/count.js';

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { stdout: { write: (s: string) => out.push(s) }, stderr: { write: (s: string) => err.push(s) } }, out: () => out.join(''), err: () => err.join('') };
}

describe('cli', () => {
  it('prints help and exits 2 with no command', async () => {
    const t = io();
    expect(await run([], t.io)).toBe(2);
    expect(t.out()).toMatch(/Usage:/);
  });
  it('prints help and exits 0 when asked', async () => {
    const t = io();
    expect(await run(['count', '--help'], t.io)).toBe(0);
  });
  it('prints the version', async () => {
    const t = io();
    expect(await run(['--version'], t.io)).toBe(0);
    expect(t.out()).toMatch(/\d+\.\d+\.\d+/);
  });
  it('rejects an unknown command with exit 2 on stderr', async () => {
    const t = io();
    expect(await run(['frobnicate'], t.io)).toBe(2);
    expect(t.err()).toMatch(/unknown command "frobnicate"/);
  });
  it('counts lines and words in files', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cli-'));
    const a = path.join(dir, 'a.txt');
    writeFileSync(a, 'one two\nthree\n');
    const t = io();
    expect(await run(['count', a], t.io)).toBe(0);
    expect(t.out()).toMatch(/2\s+.*a\.txt/);
    const w = io();
    expect(await run(['count', '--words', '--json', a], w.io)).toBe(0);
    expect(JSON.parse(w.out())[0].count).toBe(3);
  });
  it('turns a thrown error into exit 1 with a message', async () => {
    const t = io();
    expect(await run(['count', '/no/such/file.txt'], t.io)).toBe(1);
    expect(t.err()).toMatch(/count:/);
  });
});

describe('countText', () => {
  it('counts lines without a phantom last line', () => {
    expect(countText('a\nb\n', false)).toBe(2);
    expect(countText('a\nb', false)).toBe(2);
    expect(countText('', false)).toBe(0);
  });
  it('counts words', () => {
    expect(countText('  a  b\nc ', true)).toBe(3);
  });
  it('renders a table with a total for several files', () => {
    const table = renderTable([{ file: 'a', count: 1 }, { file: 'b', count: 22 }], 'lines');
    expect(table).toMatch(/23\s+total/);
  });
});
