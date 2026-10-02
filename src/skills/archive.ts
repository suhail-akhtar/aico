/**
 * Reading and writing `.skill` / `.zip` archives in the engine, with limits.
 *
 * WHY NOT THE SYSTEM UNZIPPER (what import used to do). A shelled-out `tar` or
 * `Expand-Archive` extracts first and lets us look afterwards, which is the
 * wrong order for a file from a stranger: `../../.bashrc` has already been
 * written, a symlink to `~/.ssh` already exists, and a 40 KB zip has already
 * inflated to 40 GB by the time anything checks. Reading the central
 * directory ourselves means every entry is judged *before* a byte is written:
 * names that escape the folder, links, device files, encryption, more than
 * 2,000 entries, more than 50 MB unpacked, and compression ratios no text file
 * has are all refused up front (design §5.1 import, item 2), and each entry is
 * inflated with a hard output cap so a header that lies about its size cannot
 * get past the check either.
 *
 * WHY NOT A PACKAGE. Stored and deflated entries with fixed-size headers
 * around `node:zlib` is a few hundred lines; a dependency would be more code
 * to audit (the desktop's own backup zip made the same call —
 * desktop/electron/zip.ts; the engine cannot import from desktop/, so this is
 * the engine's copy, narrowed to what skills need).
 *
 * The writer produces what Claude's `package_skill.py` produces: one top-level
 * folder named after the skill, UTF-8 names, Unix permission bits kept so a
 * script stays executable. Timestamps are fixed so the same tree always packs
 * to the same bytes.
 *
 * @module skills/archive
 */

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

export const LIMITS = {
  /** The archive file itself. */
  archiveBytes: 50 * 1024 * 1024,
  /** Everything it unpacks to. */
  unpackedBytes: 50 * 1024 * 1024,
  entries: 2000,
  /** Inflated ÷ compressed for one entry, above which it is treated as a bomb (for entries over 1 MB). */
  ratio: 100,
  ratioFloorBytes: 1024 * 1024,
};

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/** Unix file-type bits in the high half of the external attributes. */
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

export class ArchiveRefused extends Error {}

export interface ArchiveEntry {
  name: string;
  dir: boolean;
  size: number;
  compressedSize: number;
  method: number;
  crc: number;
  offset: number;
  /** Unix mode bits when the archive recorded them. */
  mode?: number;
}

function crc32(data: Uint8Array): number {
  const native = (zlib as unknown as { crc32?: (d: Uint8Array) => number }).crc32;
  if (native) return native(data) >>> 0;
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    c ^= data[i]!;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Why an entry name may not be written under a folder, or '' when it may.
 * Absolute paths, drive letters, `..` anywhere, NUL and colons (alternate
 * data streams on Windows) are all refused rather than "cleaned".
 */
export function unsafeEntryName(name: string): string {
  const n = name.replace(/\\/g, '/');
  if (!n) return 'an entry has an empty name';
  if (n.includes('\0')) return `"${n}" contains a NUL character`;
  if (n.startsWith('/') || /^[A-Za-z]:/.test(n)) return `"${n}" is an absolute path`;
  if (n.split('/').some(p => p === '..')) return `"${n}" climbs out of the folder (..)`;
  if (n.split('/').some(p => p.includes(':'))) return `"${n}" contains a colon`;
  return '';
}

/** Read and check an archive's directory. Throws ArchiveRefused with the reason. */
export function readDirectory(buf: Buffer): ArchiveEntry[] {
  if (buf.length > LIMITS.archiveBytes) {
    throw new ArchiveRefused(`the archive is ${(buf.length / 1048576).toFixed(1)} MB; the limit is ${LIMITS.archiveBytes / 1048576} MB.`);
  }
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === SIG_END) { end = i; break; }
  }
  if (end < 0) throw new ArchiveRefused('this is not a zip archive (no end-of-directory record).');
  const count = buf.readUInt16LE(end + 10);
  const cdSize = buf.readUInt32LE(end + 12);
  const cdOffset = buf.readUInt32LE(end + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ArchiveRefused('the archive uses ZIP64, which a skill never needs.');
  if (count > LIMITS.entries) throw new ArchiveRefused(`the archive has ${count} entries; the limit is ${LIMITS.entries}.`);
  if (cdOffset + cdSize > end) throw new ArchiveRefused('the archive is truncated or corrupt.');

  const out: ArchiveEntry[] = [];
  let total = 0;
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CENTRAL) throw new ArchiveRefused('the archive directory is corrupt.');
    const madeBy = buf.readUInt16LE(p + 4) >> 8;
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const extAttr = buf.readUInt32LE(p + 38);
    const offset = buf.readUInt32LE(p + 42);
    const rawName = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;

    const name = rawName.replace(/\\/g, '/');
    const why = unsafeEntryName(name.replace(/\/+$/, ''));
    if (why) throw new ArchiveRefused(`${why}.`);
    if (flags & FLAG_ENCRYPTED) throw new ArchiveRefused(`${name} is encrypted.`);
    if (method !== METHOD_STORE && method !== METHOD_DEFLATE) throw new ArchiveRefused(`${name} uses compression method ${method}; only stored and deflate are read.`);

    // Unix-made archives record the file type; links and devices are refused.
    const mode = madeBy === 3 ? (extAttr >>> 16) & 0xffff : 0;
    const type = mode & S_IFMT;
    if (type === S_IFLNK) throw new ArchiveRefused(`${name} is a symbolic link; a skill archive may contain only files and folders.`);
    if (type && type !== S_IFREG && type !== S_IFDIR) throw new ArchiveRefused(`${name} is a device or special file.`);

    const dir = name.endsWith('/') || type === S_IFDIR || (usize === 0 && (extAttr & 0x10) !== 0);
    if (!dir) {
      total += usize;
      if (total > LIMITS.unpackedBytes) throw new ArchiveRefused(`it unpacks to more than ${LIMITS.unpackedBytes / 1048576} MB.`);
      if (usize > LIMITS.ratioFloorBytes && csize > 0 && usize / csize > LIMITS.ratio) {
        throw new ArchiveRefused(`${name} expands ${Math.round(usize / csize)}× (${(usize / 1048576).toFixed(1)} MB from ${(csize / 1024).toFixed(0)} KB) — that is a zip bomb, not a skill.`);
      }
    }
    out.push({ name: name.replace(/\/+$/, ''), dir, size: usize, compressedSize: csize, method, crc, offset, ...(mode ? { mode } : {}) });
  }
  return out;
}

/** One entry's bytes, inflated with a hard cap at its declared size. */
export function readEntry(buf: Buffer, e: ArchiveEntry): Buffer {
  if (e.dir) return Buffer.alloc(0);
  if (e.offset + 30 > buf.length || buf.readUInt32LE(e.offset) !== SIG_LOCAL) throw new ArchiveRefused(`${e.name} has a corrupt header.`);
  const start = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28);
  const body = buf.subarray(start, start + e.compressedSize);
  let data: Buffer;
  if (e.method === METHOD_STORE) data = Buffer.from(body);
  else {
    try {
      // maxOutputLength makes a header that understates the size fail here
      // instead of filling memory.
      data = zlib.inflateRawSync(body, { maxOutputLength: Math.max(1, e.size) });
    } catch (err) {
      throw new ArchiveRefused(`${e.name} does not inflate to its declared size (${(err as Error).message.split('\n')[0]}).`);
    }
  }
  if (data.length !== e.size || crc32(data) !== e.crc) throw new ArchiveRefused(`${e.name} is corrupt (checksum mismatch).`);
  return data;
}

/**
 * Unpack a checked archive into `dest` (which must be empty or absent).
 * Every entry was judged by `readDirectory` before the first write.
 */
export function extractArchive(file: string, dest: string): { files: string[]; executable: string[] } {
  const stat = fs.statSync(file);
  if (stat.size > LIMITS.archiveBytes) {
    throw new ArchiveRefused(`the archive is ${(stat.size / 1048576).toFixed(1)} MB; the limit is ${LIMITS.archiveBytes / 1048576} MB.`);
  }
  const buf = fs.readFileSync(file);
  const entries = readDirectory(buf);
  const root = path.resolve(dest);
  fs.mkdirSync(root, { recursive: true });
  const files: string[] = [];
  const executable: string[] = [];
  for (const e of entries) {
    const target = path.resolve(root, e.name);
    if (target !== root && !target.startsWith(root + path.sep)) throw new ArchiveRefused(`"${e.name}" resolves outside the folder.`);
    if (e.dir) { fs.mkdirSync(target, { recursive: true }); continue; }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, readEntry(buf, e));
    files.push(e.name);
    if (e.mode && (e.mode & 0o111)) executable.push(e.name);
  }
  return { files, executable };
}

// ── writing ─────────────────────────────────────────────────────────────

/** 1980-01-01 00:00 — fixed so the same tree packs to the same bytes. */
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

export interface PackEntry { name: string; data?: Buffer; dir?: boolean; mode?: number }

/** Build a zip in memory. Names are written as given (forward slashes). */
export function packZip(entries: PackEntry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const dir = e.dir === true;
    const nameStr = dir && !e.name.endsWith('/') ? `${e.name}/` : e.name;
    const name = Buffer.from(nameStr, 'utf8');
    const raw = dir ? Buffer.alloc(0) : (e.data ?? Buffer.alloc(0));
    const deflated = raw.length > 64 ? zlib.deflateRawSync(raw, { level: 9 }) : null;
    const useDeflate = !!deflated && deflated.length < raw.length;
    const body = useDeflate ? deflated! : raw;
    const method = useDeflate ? METHOD_DEFLATE : METHOD_STORE;
    const crc = dir ? 0 : crc32(raw);
    const mode = dir ? (S_IFDIR | 0o755) : (S_IFREG | ((e.mode ?? 0o644) & 0o777));

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(SIG_CENTRAL, 0);
    cd.writeUInt16LE((3 << 8) | 20, 4); // made by Unix, so the mode bits mean something
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(FLAG_UTF8, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(DOS_TIME, 12);
    cd.writeUInt16LE(DOS_DATE, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE((((mode & 0xffff) << 16) | (dir ? 0x10 : 0)) >>> 0, 38);
    cd.writeUInt32LE(offset, 42);

    parts.push(local, name, body);
    central.push(cd, name);
    offset += 30 + name.length + body.length;
  }
  const cdBuf = Buffer.concat(central);
  const endRec = Buffer.alloc(22);
  endRec.writeUInt32LE(SIG_END, 0);
  endRec.writeUInt16LE(entries.length, 8);
  endRec.writeUInt16LE(entries.length, 10);
  endRec.writeUInt32LE(cdBuf.length, 12);
  endRec.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, endRec]);
}
