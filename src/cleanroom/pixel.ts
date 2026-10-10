/**
 * Perceptual comparison of two screenshots, with no image library.
 *
 * Browsers hand back 8-bit RGB/RGBA PNGs, non-interlaced; that is all this
 * reads (zlib is in Node, and a PNG is five filters over scanlines). A new
 * dependency for image decoding would need its own ADR and is not worth it for
 * this one use. Anything else (interlaced, 16-bit, palette) is reported as
 * "cannot compare" rather than guessed at.
 *
 * Two numbers come out: `ssim`, a block-wise structural similarity on
 * greyscale (1 = identical structure, robust to small colour shifts), and
 * `changed`, the share of pixels whose colour differs by more than a small
 * threshold. Parity is judged on both: SSIM catches layout drift, `changed`
 * catches a colour that moved.
 *
 * @module cleanroom/pixel
 */

import zlib from 'node:zlib';

export interface Raster { width: number; height: number; gray: Float32Array; rgb: Uint8Array }

export function decodePng(buf: Uint8Array): Raster | { error: string } {
  const b = Buffer.from(buf);
  if (b.length < 33 || b.readUInt32BE(0) !== 0x89504e47) return { error: 'not a PNG' };
  let pos = 8, width = 0, height = 0, depth = 0, color = 0, interlace = 0;
  const idat: Buffer[] = [];
  while (pos + 8 <= b.length) {
    const len = b.readUInt32BE(pos), type = b.toString('ascii', pos + 4, pos + 8);
    const data = b.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]!; color = data[9]!; interlace = data[12]!; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (depth !== 8 || (color !== 2 && color !== 6) || interlace !== 0) return { error: `unsupported PNG (depth ${depth}, colour type ${color}, interlace ${interlace})` };
  const bpp = color === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[y * stride + x - bpp]! : 0;
      const up = y ? out[(y - 1) * stride + x]! : 0;
      const c = x >= bpp && y ? out[(y - 1) * stride + x - bpp]! : 0;
      let v = line[x]!;
      if (f === 1) v += a; else if (f === 2) v += up; else if (f === 3) v += (a + up) >> 1;
      else if (f === 4) { const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c; }
      out[y * stride + x] = v & 255;
    }
  }
  const rgb = new Uint8Array(width * height * 3), gray = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const r = out[i * bpp]!, g = out[i * bpp + 1]!, bl = out[i * bpp + 2]!;
    rgb[i * 3] = r; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = bl;
    gray[i] = 0.299 * r + 0.587 * g + 0.114 * bl;
  }
  return { width, height, gray, rgb };
}

export interface PixelDiff { comparable: boolean; reason?: string; ssim: number; changed: number; width: number; height: number }

export function comparePng(a: Uint8Array, b: Uint8Array, threshold = 12): PixelDiff {
  const A = decodePng(a), B = decodePng(b);
  if ('error' in A) return { comparable: false, reason: A.error, ssim: 0, changed: 1, width: 0, height: 0 };
  if ('error' in B) return { comparable: false, reason: B.error, ssim: 0, changed: 1, width: 0, height: 0 };
  if (A.width !== B.width || A.height !== B.height) return { comparable: false, reason: `different sizes (${A.width}x${A.height} vs ${B.width}x${B.height})`, ssim: 0, changed: 1, width: A.width, height: A.height };
  return { comparable: true, ssim: ssim(A, B), changed: changedShare(A, B, threshold), width: A.width, height: A.height };
}

function changedShare(A: Raster, B: Raster, t: number): number {
  let n = 0;
  const total = A.width * A.height;
  for (let i = 0; i < total; i++) {
    if (Math.abs(A.rgb[i * 3]! - B.rgb[i * 3]!) > t || Math.abs(A.rgb[i * 3 + 1]! - B.rgb[i * 3 + 1]!) > t || Math.abs(A.rgb[i * 3 + 2]! - B.rgb[i * 3 + 2]!) > t) n++;
  }
  return n / total;
}

/** Mean SSIM over non-overlapping 8x8 blocks of the greyscale images. */
function ssim(A: Raster, B: Raster): number {
  const C1 = (0.01 * 255) ** 2, C2 = (0.03 * 255) ** 2, N = 8;
  let sum = 0, blocks = 0;
  for (let by = 0; by + N <= A.height; by += N) {
    for (let bx = 0; bx + N <= A.width; bx += N) {
      let ma = 0, mb = 0;
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { const i = (by + y) * A.width + bx + x; ma += A.gray[i]!; mb += B.gray[i]!; }
      ma /= N * N; mb /= N * N;
      let va = 0, vb = 0, cov = 0;
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { const i = (by + y) * A.width + bx + x; const da = A.gray[i]! - ma, db = B.gray[i]! - mb; va += da * da; vb += db * db; cov += da * db; }
      va /= N * N - 1; vb /= N * N - 1; cov /= N * N - 1;
      sum += ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
      blocks++;
    }
  }
  return blocks ? sum / blocks : 1;
}
