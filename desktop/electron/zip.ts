/**
 * A small ZIP writer and reader with no dependencies beyond `node:zlib`.
 *
 * WHY NOT A PACKAGE. The desktop needs zips in three places — backups, their
 * restore, and exporting a skill in the `.skill` format — and all three are
 * "files and folders in, files and folders out". The format for that is a few
 * fixed-size headers around deflate, which Node already has. A dependency for
 * it would be more code to audit than the code itself.
 *
 * WHAT IT HANDLES. Stored and deflated entries, directories, UTF-8 names (the
 * language-encoding flag is set on every entry it writes), archives it wrote
 * and the ordinary ones other tools write — including Windows PowerShell 5's
 * `Compress-Archive`, which puts backslashes in names. Encrypted entries and
 * ZIP64 (over 65,535 entries or 4 GiB) are refused with a message that says
 * so, rather than read wrongly.
 *
 * Two shapes: `zipSync`/`unzipSync` work on buffers (tests, small archives),
 * and `ZipWriter`/`ZipReader` stream to and from a file with async deflate, so
 * a backup that includes years of chats does not freeze the window.
 *
 * @module desktop/electron/zip
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';

const deflateRaw = promisify(zlib.deflateRaw);
const inflateRaw = promisify(zlib.inflateRaw);

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const FLAG_UTF8 = 0x0800;
const FLAG_ENCRYPTED = 0x0001;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const MAX_U16 = 0xffff;
const MAX_U32 = 0xffffffff;

/* `zlib.crc32` arrived in Node 22.2; the table is the fallback for older runtimes. */
let crcTable: Uint32Array | null = null;
export function crc32(data: Uint8Array): number {
  const native = (zlib as unknown as { crc32?: (d: Uint8Array) => number }).crc32;
  if (native) return native(data) >>> 0;
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = crcTable[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, Math.min(2107, d.getFullYear()));
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

function fromDosTime(time: number, date: number): Date {
  return new Date(1980 + (date >> 9), ((date >> 5) & 0xf) - 1, date & 0x1f, time >> 11, (time >> 5) & 0x3f, (time & 0x1f) * 2);
}

/** A name as it goes into the archive: forward slashes, no leading slash, a trailing one for folders. */
export function normaliseEntryName(name: string, dir = false): string {
  let n = name.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/{2,}/g, '/');
  if (dir && !n.endsWith('/')) n += '/';
  if (!dir) n = n.replace(/\/+$/, '');
  if (!n || n === '/') throw new Error('A zip entry needs a name.');
  return n;
}

export interface ZipInput {
  name: string;
  /** Absent (or `dir: true`) for a folder. */
  data?: Buffer | string;
  dir?: boolean;
  mtime?: Date;
}

interface CentralRecord {
  name: Buffer;
  method: number;
  time: number;
  date: number;
  crc: number;
  csize: number;
  usize: number;
  dir: boolean;
  offset: number;
}

function localHeader(r: CentralRecord): Buffer {
  const h = Buffer.alloc(30);
  h.writeUInt32LE(SIG_LOCAL, 0);
  h.writeUInt16LE(20, 4);
  h.writeUInt16LE(FLAG_UTF8, 6);
  h.writeUInt16LE(r.method, 8);
  h.writeUInt16LE(r.time, 10);
  h.writeUInt16LE(r.date, 12);
  h.writeUInt32LE(r.crc, 14);
  h.writeUInt32LE(r.csize, 18);
  h.writeUInt32LE(r.usize, 22);
  h.writeUInt16LE(r.name.length, 26);
  h.writeUInt16LE(0, 28);
  return Buffer.concat([h, r.name]);
}

function centralHeader(r: CentralRecord): Buffer {
  const h = Buffer.alloc(46);
  h.writeUInt32LE(SIG_CENTRAL, 0);
  h.writeUInt16LE(20, 4); // made by: MS-DOS attributes, spec 2.0
  h.writeUInt16LE(20, 6);
  h.writeUInt16LE(FLAG_UTF8, 8);
  h.writeUInt16LE(r.method, 10);
  h.writeUInt16LE(r.time, 12);
  h.writeUInt16LE(r.date, 14);
  h.writeUInt32LE(r.crc, 16);
  h.writeUInt32LE(r.csize, 20);
  h.writeUInt32LE(r.usize, 24);
  h.writeUInt16LE(r.name.length, 28);
  h.writeUInt16LE(0, 30);
  h.writeUInt16LE(0, 32);
  h.writeUInt16LE(0, 34);
  h.writeUInt16LE(0, 36);
  h.writeUInt32LE(r.dir ? 0x10 : 0, 38);
  h.writeUInt32LE(r.offset, 42);
  return Buffer.concat([h, r.name]);
}

function endRecord(count: number, cdSize: number, cdOffset: number): Buffer {
  if (count > MAX_U16) throw new Error(`Too many files for a zip without ZIP64 (${count}; the limit is ${MAX_U16}).`);
  if (cdOffset + cdSize > MAX_U32) throw new Error('The archive would be larger than 4 GiB, which needs ZIP64.');
  const e = Buffer.alloc(22);
  e.writeUInt32LE(SIG_END, 0);
  e.writeUInt16LE(count, 8);
  e.writeUInt16LE(count, 10);
  e.writeUInt32LE(cdSize, 12);
  e.writeUInt32LE(cdOffset, 16);
  return e;
}

/** Deflate when it helps; small or already-compressed data is stored as is. */
function chooseCompressed(raw: Buffer, deflated: Buffer | null): { method: number; body: Buffer } {
  return deflated && deflated.length < raw.length ? { method: METHOD_DEFLATE, body: deflated } : { method: METHOD_STORE, body: raw };
}

function toBuffer(data: Buffer | string | undefined): Buffer {
  return data === undefined ? Buffer.alloc(0) : typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
}

/** Build a whole archive in memory. */
export function zipSync(entries: ZipInput[]): Buffer {
  const parts: Buffer[] = [];
  const records: CentralRecord[] = [];
  let offset = 0;
  for (const e of entries) {
    const dir = e.dir === true || e.data === undefined;
    const name = Buffer.from(normaliseEntryName(e.name, dir), 'utf8');
    const raw = dir ? Buffer.alloc(0) : toBuffer(e.data);
    const { method, body } = dir ? { method: METHOD_STORE, body: raw } : chooseCompressed(raw, raw.length > 64 ? zlib.deflateRawSync(raw) : null);
    const { time, date } = dosTime(e.mtime ?? new Date());
    const rec: CentralRecord = { name, method, time, date, crc: dir ? 0 : crc32(raw), csize: body.length, usize: raw.length, dir, offset };
    const head = localHeader(rec);
    parts.push(head, body);
    records.push(rec);
    offset += head.length + body.length;
  }
  const cd = Buffer.concat(records.map(centralHeader));
  return Buffer.concat([...parts, cd, endRecord(records.length, cd.length, offset)]);
}

/** Writes an archive to a file one entry at a time. */
export class ZipWriter {
  private records: CentralRecord[] = [];
  private offset = 0;
  private names = new Set<string>();

  private constructor(private readonly fh: fs.promises.FileHandle, readonly file: string) {}

  static async create(file: string): Promise<ZipWriter> {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    return new ZipWriter(await fs.promises.open(file, 'w'), file);
  }

  get count(): number { return this.records.length; }
  get bytes(): number { return this.offset; }

  private async write(buf: Buffer): Promise<void> {
    await this.fh.write(buf, 0, buf.length, this.offset);
    this.offset += buf.length;
  }

  private async add(name: string, dir: boolean, raw: Buffer, mtime?: Date): Promise<void> {
    const n = normaliseEntryName(name, dir);
    if (this.names.has(n)) return; // a folder added twice (implicitly and explicitly) is still one folder
    this.names.add(n);
    const { method, body } = dir ? { method: METHOD_STORE, body: raw } : chooseCompressed(raw, raw.length > 64 ? await deflateRaw(raw) : null);
    const { time, date } = dosTime(mtime ?? new Date());
    const rec: CentralRecord = { name: Buffer.from(n, 'utf8'), method, time, date, crc: dir ? 0 : crc32(raw), csize: body.length, usize: raw.length, dir, offset: this.offset };
    if (this.offset + body.length > MAX_U32) throw new Error('The archive would be larger than 4 GiB, which needs ZIP64.');
    await this.write(localHeader(rec));
    await this.write(body);
    this.records.push(rec);
  }

  addFile(name: string, data: Buffer | string, mtime?: Date): Promise<void> {
    return this.add(name, false, toBuffer(data), mtime);
  }

  addDir(name: string, mtime?: Date): Promise<void> {
    return this.add(name, true, Buffer.alloc(0), mtime);
  }

  /** Add a file from disk under `name`, keeping its modification time. */
  async addPath(name: string, file: string): Promise<void> {
    const st = await fs.promises.stat(file);
    await this.addFile(name, await fs.promises.readFile(file), st.mtime);
  }

  /** Write the central directory and close. Returns the archive's size. */
  async finish(): Promise<number> {
    const cdOffset = this.offset;
    const cd = Buffer.concat(this.records.map(centralHeader));
    await this.write(cd);
    await this.write(endRecord(this.records.length, cd.length, cdOffset));
    await this.fh.close();
    return this.offset;
  }

  /** Close and delete a half-written archive. */
  async abort(): Promise<void> {
    await this.fh.close().catch(() => {});
    await fs.promises.rm(this.file, { force: true }).catch(() => {});
  }
}

export interface ZipEntry {
  name: string;
  dir: boolean;
  size: number;
  compressedSize: number;
  method: number;
  crc: number;
  mtime: Date;
  /** Where the local header starts. */
  offset: number;
}

/** Random access to an archive's bytes: a buffer or an open file. */
interface Source {
  size: number;
  read(pos: number, len: number): Promise<Buffer>;
  close(): Promise<void>;
}

function bufferSource(buf: Buffer): Source {
  return { size: buf.length, read: async (pos, len) => buf.subarray(pos, pos + len), close: async () => {} };
}

/** Find the end-of-central-directory record in the archive's last bytes. */
function findEnd(tail: Buffer, tailStart: number): { count: number; cdSize: number; cdOffset: number } {
  let end = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === SIG_END) { end = i; break; }
  }
  if (end < 0) throw new Error('Not a zip archive (no end-of-directory record).');
  const count = tail.readUInt16LE(end + 10);
  const cdSize = tail.readUInt32LE(end + 12);
  const cdOffset = tail.readUInt32LE(end + 16);
  if (count === MAX_U16 || cdSize === MAX_U32 || cdOffset === MAX_U32) throw new Error('This archive uses ZIP64, which is not supported.');
  if (cdOffset + cdSize > tailStart + end) throw new Error('The zip archive is truncated or corrupt.');
  return { count, cdSize, cdOffset };
}

function parseCentralDirectory(cd: Buffer, count: number): ZipEntry[] {
  const out: ZipEntry[] = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== SIG_CENTRAL) throw new Error('The zip directory is corrupt.');
    const flags = cd.readUInt16LE(p + 8);
    const method = cd.readUInt16LE(p + 10);
    const time = cd.readUInt16LE(p + 12);
    const date = cd.readUInt16LE(p + 14);
    const crc = cd.readUInt32LE(p + 16);
    const csize = cd.readUInt32LE(p + 20);
    const usize = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const extAttr = cd.readUInt32LE(p + 38);
    const offset = cd.readUInt32LE(p + 42);
    if (flags & FLAG_ENCRYPTED) throw new Error('Encrypted zip archives are not supported.');
    // Names without the UTF-8 flag are CP437 by the letter of the spec, but in
    // practice every tool writes UTF-8 (or plain ASCII, which is the same).
    const raw = cd.subarray(p + 46, p + 46 + nameLen).toString('utf8').replace(/\\/g, '/');
    const dir = raw.endsWith('/') || (usize === 0 && (extAttr & 0x10) !== 0);
    out.push({ name: raw.replace(/\/+$/, ''), dir, size: usize, compressedSize: csize, method, crc, mtime: fromDosTime(time, date), offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function parseBuffer(buf: Buffer): ZipEntry[] {
  const end = findEnd(buf, 0);
  return parseCentralDirectory(buf.subarray(end.cdOffset, end.cdOffset + end.cdSize), end.count);
}

async function readEntryData(src: Source, e: ZipEntry, inflate: (b: Buffer) => Promise<Buffer> | Buffer): Promise<Buffer> {
  if (e.dir) return Buffer.alloc(0);
  const head = await src.read(e.offset, 30);
  if (head.length < 30 || head.readUInt32LE(0) !== SIG_LOCAL) throw new Error(`Corrupt entry header for ${e.name}.`);
  const start = e.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
  const body = await src.read(start, e.compressedSize);
  let data: Buffer;
  if (e.method === METHOD_STORE) data = Buffer.from(body);
  else if (e.method === METHOD_DEFLATE) data = await inflate(body);
  else throw new Error(`${e.name} uses compression method ${e.method}, which is not supported (only stored and deflate).`);
  if (data.length !== e.size || crc32(data) !== e.crc) throw new Error(`${e.name} is corrupt (checksum mismatch).`);
  return data;
}

/** Reads an archive from a buffer or a file. */
export class ZipReader {
  private constructor(private readonly src: Source, readonly entries: ZipEntry[]) {}

  static async fromBuffer(buf: Buffer): Promise<ZipReader> {
    return new ZipReader(bufferSource(buf), parseBuffer(buf));
  }

  static async open(file: string): Promise<ZipReader> {
    const fh = await fs.promises.open(file, 'r');
    try {
      const size = (await fh.stat()).size;
      const src: Source = {
        size,
        async read(pos, len) {
          const b = Buffer.alloc(Math.max(0, Math.min(len, size - pos)));
          if (b.length) await fh.read(b, 0, b.length, pos);
          return b;
        },
        close: () => fh.close(),
      };
      const tailLen = Math.min(size, 22 + 0xffff);
      const tail = await src.read(size - tailLen, tailLen);
      const end = findEnd(tail, size - tailLen);
      // The directory is read whole: its size is known and bounded by the entry limit.
      const cd = await src.read(end.cdOffset, end.cdSize);
      return new ZipReader(src, parseCentralDirectory(cd, end.count));
    } catch (err) {
      await fh.close().catch(() => {});
      throw err;
    }
  }

  find(name: string): ZipEntry | undefined {
    const n = name.replace(/\\/g, '/').replace(/\/+$/, '');
    return this.entries.find(e => e.name === n);
  }

  read(entry: ZipEntry | string): Promise<Buffer> {
    const e = typeof entry === 'string' ? this.find(entry) : entry;
    if (!e) return Promise.reject(new Error(`No ${String(entry)} in the archive.`));
    return readEntryData(this.src, e, inflateRaw);
  }

  close(): Promise<void> { return this.src.close(); }
}

/** Every entry of an in-memory archive, with its contents. */
export function unzipSync(buf: Buffer): Array<ZipEntry & { data: Buffer }> {
  return parseBuffer(buf).map(e => {
    if (e.dir) return { ...e, data: Buffer.alloc(0) };
    const start = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28);
    if (buf.readUInt32LE(e.offset) !== SIG_LOCAL) throw new Error(`Corrupt entry header for ${e.name}.`);
    const body = buf.subarray(start, start + e.compressedSize);
    let data: Buffer;
    if (e.method === METHOD_STORE) data = Buffer.from(body);
    else if (e.method === METHOD_DEFLATE) data = zlib.inflateRawSync(body);
    else throw new Error(`${e.name} uses compression method ${e.method}, which is not supported (only stored and deflate).`);
    if (data.length !== e.size || crc32(data) !== e.crc) throw new Error(`${e.name} is corrupt (checksum mismatch).`);
    return { ...e, data };
  });
}

/**
 * Where an entry lands under `root`, or null when its name would escape it
 * ("zip slip": `../`, an absolute path, a drive letter).
 */
export function safeEntryPath(root: string, name: string): string | null {
  const n = name.replace(/\\/g, '/');
  if (!n || n.startsWith('/') || /^[a-zA-Z]:/.test(n) || n.split('/').some(part => part === '..')) return null;
  const target = path.resolve(root, n);
  const rel = path.relative(path.resolve(root), target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return target;
}

/** Every file and folder under `dir`, as forward-slash paths relative to it (folders end in "/"). */
export function walk(dir: string, filter?: (rel: string, isDir: boolean) => boolean): string[] {
  const out: string[] = [];
  const visit = (abs: string, rel: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue; // a link can point anywhere; a backup copies what is here
      if (e.isDirectory()) {
        if (filter && !filter(r, true)) continue;
        out.push(`${r}/`);
        visit(path.join(abs, e.name), r);
      } else if (e.isFile()) {
        if (filter && !filter(r, false)) continue;
        out.push(r);
      }
    }
  };
  visit(dir, '');
  return out;
}

/**
 * Zip a folder. With `rootName`, everything sits under that one top-level
 * folder — the `.skill` layout (`<name>/SKILL.md`, …); without, the folder's
 * contents are at the archive root.
 */
export async function zipDirectory(srcDir: string, destFile: string, rootName?: string): Promise<{ file: string; entries: number; bytes: number }> {
  const st = await fs.promises.stat(srcDir).catch(() => null);
  if (!st?.isDirectory()) throw new Error(`Not a folder: ${srcDir}`);
  const prefix = rootName ? `${normaliseEntryName(rootName, true)}` : '';
  const dest = path.resolve(destFile);
  const w = await ZipWriter.create(dest);
  try {
    if (prefix) await w.addDir(prefix, st.mtime);
    for (const rel of walk(srcDir, (r) => path.resolve(srcDir, r) !== dest)) {
      if (rel.endsWith('/')) await w.addDir(prefix + rel);
      else await w.addPath(prefix + rel, path.join(srcDir, rel));
    }
    const bytes = await w.finish();
    return { file: dest, entries: w.count, bytes };
  } catch (err) {
    await w.abort();
    throw err;
  }
}

/** Unpack an archive into `destDir`, refusing any entry that would land outside it. */
export async function extractZip(file: string, destDir: string, filter?: (name: string) => boolean): Promise<string[]> {
  const r = await ZipReader.open(file);
  const written: string[] = [];
  try {
    for (const e of r.entries) {
      if (filter && !filter(e.name)) continue;
      const target = safeEntryPath(destDir, e.name);
      if (!target) throw new Error(`Refusing an entry that points outside the destination: ${e.name}`);
      if (e.dir) { await fs.promises.mkdir(target, { recursive: true }); continue; }
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.writeFile(target, await r.read(e));
      written.push(target);
    }
  } finally {
    await r.close();
  }
  return written;
}
