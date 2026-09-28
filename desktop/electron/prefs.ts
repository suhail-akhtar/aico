/**
 * Reads and writes `~/.aico/desktop/prefs.json`.
 *
 * Written atomically (temp file, then rename) so a crash mid-write cannot leave
 * a truncated file that resets someone's theme. A file that does not parse is
 * kept aside as `prefs.json.bad` rather than silently overwritten.
 *
 * @module desktop/electron/prefs
 */

import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { DEFAULT_PREFS, mergePrefs, type DesktopPrefs } from '../shared/prefs';

export class PrefsStore extends EventEmitter {
  private value: DesktopPrefs;
  private writeTimer: NodeJS.Timeout | null = null;

  constructor(private readonly file: string) {
    super();
    this.value = this.load();
  }

  get(): DesktopPrefs { return this.value; }

  set(patch: Partial<DesktopPrefs>): DesktopPrefs {
    this.value = mergePrefs(this.value, patch);
    this.scheduleWrite();
    this.emit('change', this.value);
    return this.value;
  }

  /** Write now — called on quit so the last window position is not lost. */
  flush(): void {
    if (this.writeTimer) { clearTimeout(this.writeTimer); this.writeTimer = null; }
    this.write();
  }

  private load(): DesktopPrefs {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      return mergePrefs(DEFAULT_PREFS, JSON.parse(raw));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        try { fs.renameSync(this.file, this.file + '.bad'); } catch { /* nothing to keep */ }
      }
      return structuredClone(DEFAULT_PREFS);
    }
  }

  private scheduleWrite(): void {
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(() => { this.writeTimer = null; this.write(); }, 250);
  }

  private write(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.value, null, 2));
      fs.renameSync(tmp, this.file);
    } catch {
      // A read-only home is not a reason to crash the app; prefs just won't persist.
    }
  }
}
