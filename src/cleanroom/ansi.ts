/**
 * A small terminal screen: replay an ANSI byte stream, read back the rows.
 *
 * Why not compare raw output: a TUI redraws the same screen with different
 * escape sequences (cursor jumps, partial clears, colour resets) and two
 * programs that look identical emit different bytes. The twin-test needs "what
 * is on the screen", so this interprets the sequences that move text and
 * ignores the ones that only colour it. Colour is kept separately by
 * {@link sgrRuns} when a caller wants to compare styling.
 *
 * Handled: printable text, CR/LF/BS/TAB, cursor moves (CSI A B C D E F G H f),
 * erase in display/line (J K), save/restore cursor (s u), and the private
 * modes for the alternate screen and cursor visibility (ignored). OSC and
 * other CSI are skipped. Wide characters are counted as one cell: good enough
 * for equality checks, not a renderer.
 *
 * @module cleanroom/ansi
 */

export interface Screen { rows: string[]; cursor: { row: number; col: number } }

export function renderScreen(stream: string, columns = 80, rows = 24): Screen {
  const grid: string[][] = Array.from({ length: rows }, () => Array<string>(columns).fill(' '));
  let r = 0, c = 0, saved = { r: 0, c: 0 };
  const clampR = (n: number): number => Math.max(0, Math.min(rows - 1, n));
  const clampC = (n: number): number => Math.max(0, Math.min(columns - 1, n));
  const scrollUp = (): void => { grid.shift(); grid.push(Array<string>(columns).fill(' ')); };
  const lineFeed = (): void => { if (r === rows - 1) scrollUp(); else r++; };

  for (let i = 0; i < stream.length; i++) {
    const ch = stream[i]!;
    if (ch === '\x1b') {
      const next = stream[i + 1];
      if (next === '[') {
        let j = i + 2;
        while (j < stream.length && !/[@-~]/.test(stream[j]!)) j++;
        const body = stream.slice(i + 2, j);
        const final = stream[j];
        i = j;
        if (!final || body.startsWith('?') || body.startsWith('>')) continue; // private modes: alt screen, cursor, mouse
        const n = body.split(';').map(x => (x === '' ? NaN : Number(x)));
        const a = Number.isNaN(n[0]!) ? 1 : n[0]!;
        switch (final) {
          case 'A': r = clampR(r - a); break;
          case 'B': r = clampR(r + a); break;
          case 'C': c = clampC(c + a); break;
          case 'D': c = clampC(c - a); break;
          case 'E': r = clampR(r + a); c = 0; break;
          case 'F': r = clampR(r - a); c = 0; break;
          case 'G': c = clampC(a - 1); break;
          case 'H': case 'f': r = clampR((Number.isNaN(n[0]!) ? 1 : n[0]!) - 1); c = clampC((Number.isNaN(n[1] ?? NaN) ? 1 : n[1]!) - 1); break;
          case 'J': {
            const mode = Number.isNaN(n[0]!) ? 0 : n[0]!;
            if (mode === 2 || mode === 3) for (const row of grid) row.fill(' ');
            else if (mode === 0) { grid[r]!.fill(' ', c); for (let k = r + 1; k < rows; k++) grid[k]!.fill(' '); }
            else if (mode === 1) { grid[r]!.fill(' ', 0, c + 1); for (let k = 0; k < r; k++) grid[k]!.fill(' '); }
            break;
          }
          case 'K': {
            const mode = Number.isNaN(n[0]!) ? 0 : n[0]!;
            if (mode === 0) grid[r]!.fill(' ', c); else if (mode === 1) grid[r]!.fill(' ', 0, c + 1); else grid[r]!.fill(' ');
            break;
          }
          case 's': saved = { r, c }; break;
          case 'u': r = saved.r; c = saved.c; break;
          default: break; // SGR (m) and the rest change look, not content
        }
        continue;
      }
      if (next === ']') { // OSC: up to BEL or ST
        let j = i + 2;
        while (j < stream.length && stream[j] !== '\x07' && !(stream[j] === '\x1b' && stream[j + 1] === '\\')) j++;
        i = stream[j] === '\x07' ? j : j + 1;
        continue;
      }
      i += 1; // a two-character escape (ESC 7, ESC c, ...): skipped
      continue;
    }
    if (ch === '\r') { c = 0; continue; }
    if (ch === '\n') { lineFeed(); continue; } // a bare LF keeps the column, as a raw-mode program expects
    if (ch === '\b') { c = clampC(c - 1); continue; }
    if (ch === '\t') { c = clampC((Math.floor(c / 8) + 1) * 8); continue; }
    if (ch < ' ') continue;
    if (c >= columns) { c = 0; lineFeed(); }
    grid[r]![c] = ch;
    c++;
  }
  return { rows: grid.map(row => row.join('').replace(/\s+$/, '')), cursor: { row: r, col: c } };
}

/** The text of a screen without trailing blank rows. */
export function screenText(s: Screen): string[] {
  const rows = [...s.rows];
  while (rows.length && rows[rows.length - 1] === '') rows.pop();
  return rows;
}

/** Strip every escape sequence: the plain text a line-oriented program wrote. */
export function stripAnsi(s: string): string {
  return s.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?>]*[@-~]/g, '').replace(/\x1b[@-Z\\-_]/g, '');
}

/** The distinct SGR parameter sets used, in order: a coarse "what was styled" signature. */
export function sgrRuns(s: string): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(/\x1b\[([0-9;]*)m/g)) { const p = m[1] || '0'; if (out[out.length - 1] !== p) out.push(p); }
  return out;
}
