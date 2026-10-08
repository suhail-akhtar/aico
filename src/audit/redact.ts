/**
 * The last filter before a string leaves in an audit export (ADR 0035).
 *
 * The export is built from records that were already redacted when they were
 * written (the session log, the vault's trail). This does not trust that: it
 * runs every string again, because an audit file is the one artefact meant to
 * be copied off the machine and kept for years.
 *
 * Three layers, strongest first:
 *  1. the vault's registered secret values (`sinkRedactText`) — exact values
 *     the person stored;
 *  2. the repository's high-confidence key shapes (`shared/security/rules`),
 *     redacted even when they spell a placeholder word — the scan skips those
 *     to avoid noise, but an exported fake is still better gone;
 *  3. command-line shapes that carry a secret without looking like a key:
 *     `--password x`, `TOKEN=x`, `Authorization: Bearer x`, `user:pass@host`.
 *
 * This is a net, not a proof: a secret that matches none of these and sits in
 * a command line or a path is exported as written (bounded in length). The ADR
 * lists it as a residual risk, and the exporter exports no content fields at
 * all so the net only has to catch what a person typed into a command.
 *
 * @module audit/redact
 */

import { SECRET_PATTERNS } from '../../shared/security/rules.mjs';
import { sinkRedactText } from '../vault/sink.js';

const MASK = '[redacted]';

const COMMAND_SHAPES: RegExp[] = [
  // --password=hunter2, --token hunter2, -p hunter2 is too ambiguous to guess at
  /(--?(?:password|passwd|pwd|pass|token|secret|api[-_]?key|apikey|access[-_]?key|auth|credential)s?)(?:=|\s+)(?!-)(?:"[^"]*"|'[^']*'|\S+)/gi,
  // NAME=value where the name says it is a secret
  /\b([A-Za-z0-9_.-]*(?:key|token|secret|password|passwd|credential)[A-Za-z0-9_.-]*)=(?:"[^"]*"|'[^']*'|\S+)/gi,
  // Authorization / Bearer / Basic
  /\b(authorization\s*[:=]\s*)(?:bearer|basic|token)?\s*[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi,
  // user:password@host in a URL
  /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+(@)/gi,
];

/** A string safe to put in an export: redacted, one line, no control characters, at most `max` characters. */
export function auditText(value: unknown, max = 300): string {
  if (value === undefined || value === null) return '';
  let s = typeof value === 'string' ? value : JSON.stringify(value);
  if (typeof s !== 'string') return '';
  s = sinkRedactText(s);
  for (const { re } of SECRET_PATTERNS) s = s.replace(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`), MASK);
  s = s.replace(COMMAND_SHAPES[0]!, `$1 ${MASK}`)
    .replace(COMMAND_SHAPES[1]!, `$1=${MASK}`)
    .replace(COMMAND_SHAPES[2]!, `$1${MASK}`)
    .replace(COMMAND_SHAPES[3]!, `$1${MASK}`)
    .replace(COMMAND_SHAPES[4]!, `$1${MASK}$2`);
  // One line, no control characters (log injection into a SIEM), bounded.
  s = s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Where a call acted, with no content: a file path, a command (redacted and
 * cut), a URL's host and path **without its query string or credentials**, or
 * a search pattern. Never a file body, a prompt, or an argument value that is
 * not one of these named fields.
 */
export function callTarget(name: string, args: unknown): string {
  const a = args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {};
  const str = (k: string): string | undefined => (typeof a[k] === 'string' && a[k] ? a[k] as string : undefined);
  const url = str('url') ?? str('uri') ?? str('endpoint');
  if (url) {
    try {
      const u = new URL(url);
      return auditText(`${u.protocol}//${u.host}${u.pathname}`, 200);
    } catch { return auditText(url.split(/[?#]/)[0], 200); }
  }
  const file = str('file_path') ?? str('path') ?? str('notebook_path') ?? str('directory') ?? str('cwd');
  if (file) return auditText(file, 200);
  const command = str('command') ?? str('cmd');
  if (command) return auditText(command, 200);
  const pattern = str('pattern') ?? str('query');
  if (pattern) return auditText(pattern, 120);
  const other = str('name') ?? str('action') ?? str('server');
  void name;
  return other ? auditText(other, 120) : '';
}
