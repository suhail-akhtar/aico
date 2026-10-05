/**
 * Paths a file a person attaches by path may never be: devices and network
 * shares. Shared so the engine (`@attach` in the terminal, src/attachments.ts)
 * and the desktop's attach dialog (desktop/electron/core-ipc.ts) refuse the
 * same list.
 *
 * WHY: attaching by path read whatever the path named. A UNC path
 * (`\\host\share\x`) makes Windows open an SMB connection — and hand the
 * person's NTLM hash to `host` — before anything is read; a device name (`CON`,
 * `NUL`, `COM1`, `\\.\PhysicalDrive0`) or `/dev/…`, `/proc/…` is not a file at
 * all, and reading one blocks or returns what it should not (security review
 * 2026-10). These are refused from the text alone, before the filesystem is
 * touched. Containment in the project / store is decided elsewhere (realpath
 * against the roots) — this is the part no root check can catch in time.
 *
 * Pure string logic: no `fs`, no `path`, so it runs anywhere and decides the
 * same on every machine for a given platform.
 *
 * @module shared/path-refusal
 */

/** Windows reserved device names, matched on a segment's name before its first dot. */
const WIN_DEVICE = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$|clock\$)$/i;

/**
 * Why `p` names a device or a network location rather than a local file, or
 * undefined when it does not. `platform` defaults to the running one.
 */
export function devicePathProblem(p: string, platform: string = typeof process !== 'undefined' ? process.platform : 'linux'): string | undefined {
  if (typeof p !== 'string' || !p) return undefined;
  if (p.includes('\0')) return 'The path contains a NUL character.';
  const win = platform === 'win32';
  // `\\host\share`, `\\.\device`, `\\?\…` — and `//host/share`, which Windows reads the same way.
  if (/^[\\/]{2}/.test(p)) {
    return win || p.startsWith('\\\\')
      ? 'Network (UNC) and device paths cannot be attached; copy the file into the project first.'
      : undefined;
  }
  if (win) {
    const segments = p.split(/[\\/]+/).filter(Boolean);
    for (const segment of segments) {
      if (/^[A-Za-z]:$/.test(segment)) continue;
      // Windows ignores trailing dots and spaces, and anything after the first dot: `nul.txt` is NUL.
      const name = segment.replace(/[. ]+$/, '').split('.')[0]!.trim();
      if (WIN_DEVICE.test(name)) return `${segment} is a Windows device name, not a file, and cannot be attached.`;
    }
    return undefined;
  }
  if (/^\/(?:dev|proc|sys)(?:\/|$)/.test(p)) return `${p.split('/')[1]} paths are devices or kernel files, not files to attach.`;
  return undefined;
}
