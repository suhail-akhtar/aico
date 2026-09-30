/**
 * Encrypted backups of the vault, for the Credential Manager's Export and
 * Import buttons.
 *
 * The file format is the one `aico vault export` writes (see cli.ts): every
 * record's metadata, policy and secret, as JSON, wrapped with AES-256-GCM
 * under a key scrypt derives from a passphrase the person chooses. A file
 * written by either can be read by the other.
 *
 * Why it lives apart from the CLI: the CLI reads its passphrase from a hidden
 * terminal prompt and writes the file itself; the desktop's passphrase comes
 * from a main-owned secure prompt and main writes the file after a save
 * dialog. Both need the same sealing and the same validation, and neither
 * should reimplement the other's I/O.
 *
 * What it deliberately does not do: decide who may export. That is a human
 * grant (`export`), checked by the broker before a single record is read.
 *
 * @module vault/backup
 */

import { newScryptParams, scryptKey, unwrap, wrap, type ScryptParams, type Wrapped } from './crypto.js';
import { CREDENTIAL_KINDS, VaultError, type CredentialMeta, type Policy } from './types.js';

export const EXPORT_LABEL = 'aico-vault-export';

export interface ExportFile {
  format: 'aico-vault-export';
  version: 1;
  scrypt: ScryptParams;
  data: Wrapped;
}

export interface ExportRecord {
  meta: CredentialMeta;
  policy: Policy;
  secret: Record<string, string>;
}

/** Seal records with a passphrase. The passphrase is never stored. */
export function sealExport(records: ExportRecord[], passphrase: string): string {
  if (typeof passphrase !== 'string' || passphrase.length < 8) {
    throw new VaultError('invalid', 'An export passphrase must be at least 8 characters.');
  }
  const scrypt = newScryptParams();
  const key = scryptKey(passphrase, scrypt);
  const plain = Buffer.from(JSON.stringify(records), 'utf8');
  try {
    const file: ExportFile = { format: 'aico-vault-export', version: 1, scrypt, data: wrap(key, plain, EXPORT_LABEL) };
    return JSON.stringify(file, null, 1);
  } finally {
    plain.fill(0);
    key.fill(0);
  }
}

/**
 * Open an export. Errors name what is wrong with the file, never its content:
 * a message that quoted a record would put a secret in a log.
 */
export function openExport(text: string, passphrase: string): ExportRecord[] {
  let parsed: ExportFile;
  try { parsed = JSON.parse(text) as ExportFile; } catch { throw new VaultError('invalid', 'That is not a readable AICO vault export.'); }
  if (!parsed || parsed.format !== 'aico-vault-export' || parsed.version !== 1 || !parsed.scrypt || !parsed.data) {
    throw new VaultError('format', 'That is not an AICO vault export (or it is from a newer version).');
  }
  const key = scryptKey(String(passphrase ?? ''), parsed.scrypt);
  const plain = unwrap(key, parsed.data, EXPORT_LABEL);
  key.fill(0);
  if (!plain) throw new VaultError('wrong-passphrase', 'Wrong passphrase, or the file was modified.');
  let records: unknown;
  try { records = JSON.parse(plain.toString('utf8')); } catch { records = undefined; } finally { plain.fill(0); }
  if (!Array.isArray(records)) throw new VaultError('format', 'The export is damaged.');
  return records.filter((r): r is ExportRecord => {
    const x = r as Partial<ExportRecord>;
    return Boolean(x && x.meta && typeof x.meta.name === 'string' && CREDENTIAL_KINDS.includes(x.meta.kind)
      && x.policy && typeof x.policy === 'object' && x.secret && typeof x.secret === 'object');
  });
}
