/**
 * How big a picture is, read from its header rather than by decoding it.
 *
 * The size that matters is not the file size. A PNG of one flat colour at
 * 20000×20000 compresses to a few hundred kilobytes — it passes a ten-megabyte
 * limit without trouble, and is then rejected by the provider for exceeding a
 * dimension limit, *after* the bytes are already in the turn. On a durable
 * transcript that rejection repeats on every later replay of the message.
 * Catching it here turns a permanently broken conversation into one clear
 * upload error.
 *
 * There is deliberately only one limit. A pixel-area cap alongside it was
 * written first and then removed: with an 8000px edge, the largest image that
 * can pass is 8000x8000, which is exactly 64 megapixels — so an area cap of 64
 * megapixels could never once have fired. Two limits where only one binds is
 * not defence in depth, it is a number that drifts out of step with the one
 * that matters.
 *
 * The decompression-bomb argument for keeping it does not apply here either:
 * this module reads headers and the bytes are passed through base64 untouched.
 * Nothing in this process ever expands an image, so the memory it would take
 * to do so is not ours to guard.
 *
 * Every format here is read from its header alone: a fixed offset for PNG and
 * GIF, a short segment walk for JPEG, a three-way branch for WebP. No decoding,
 * no dependency, and nothing that scales with the size of the image.
 *
 * @module server/image-dimensions
 */

export interface Dimensions { width: number; height: number }

export const IMAGE_LIMITS = {
  /**
   * Longest edge, in pixels. Inclusive — exactly this is fine.
   *
   * Set to the tightest limit among the providers this platform can send to
   * rather than to a generous average. The point is that an accepted upload
   * can be sent *anywhere*; a cap that only suits the most permissive vendor
   * would move the failure from upload time to run time for everyone else,
   * which is the failure this module exists to prevent.
   *
   * Raising this reopens the question the module note closes: past about 8000
   * an area cap starts to bind again, and would need adding back.
   */
  maxEdge: 8000,
} as const;

/**
 * The dimensions of an image, or nothing if its header does not say.
 *
 * Nothing is a real answer rather than a failure: a truncated file, a format
 * variant this does not know, a JPEG whose size lives past where the walk
 * gives up. The caller decides what an unknown size means — and the honest
 * default is to allow it, because the alternative is refusing valid images on
 * the strength of not having parsed them.
 */
export function imageDimensions(extension: string, bytes: Buffer): Dimensions | undefined {
  switch (extension) {
    case '.png': return pngDimensions(bytes);
    case '.gif': return gifDimensions(bytes);
    case '.jpg':
    case '.jpeg': return jpegDimensions(bytes);
    case '.webp': return webpDimensions(bytes);
    default: return undefined;
  }
}

/**
 * Why this image is too big to accept, in words worth showing.
 *
 * Returns nothing when it is fine, including when the size could not be read.
 */
export function describeOversize(dimensions: Dimensions | undefined): string | undefined {
  if (!dimensions) return undefined;
  const { width, height } = dimensions;
  if (width > IMAGE_LIMITS.maxEdge || height > IMAGE_LIMITS.maxEdge) {
    return `image is ${width}×${height}; the longest edge must be at most `
      + `${IMAGE_LIMITS.maxEdge}px. Scale it down and attach it again.`;
  }
  return undefined;
}

/** IHDR is the first chunk and its position is fixed by the spec. */
function pngDimensions(bytes: Buffer): Dimensions | undefined {
  if (bytes.length < 24) return undefined;
  // Belt and braces: the caller has already checked the signature, but this
  // reads at fixed offsets and a wrong guess here would be a plausible number
  // rather than an obvious failure.
  if (bytes.subarray(12, 16).toString('latin1') !== 'IHDR') return undefined;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** The logical screen descriptor, little-endian, immediately after the magic. */
function gifDimensions(bytes: Buffer): Dimensions | undefined {
  if (bytes.length < 10) return undefined;
  return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
}

/**
 * JPEG keeps its size in a start-of-frame marker somewhere after the header.
 *
 * Walked rather than indexed, because how much metadata precedes the frame —
 * EXIF, ICC profiles, thumbnails — varies by camera and by editor. The walk is
 * bounded by the segment lengths the file itself declares, so a malformed file
 * ends it rather than spinning.
 */
function jpegDimensions(bytes: Buffer): Dimensions | undefined {
  let offset = 2; // past SOI
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1]!;
    // Start of frame, in all its variants. C4 is a Huffman table, C8 is
    // reserved and CC is an arithmetic-coding table — they share the range and
    // carry no dimensions.
    if (marker >= 0xc0 && marker <= 0xcf
      && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    }
    // Start of scan means the entropy-coded data begins and there is no
    // further segment structure to walk.
    if (marker === 0xda) return undefined;
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2) return undefined;
    offset += 2 + length;
  }
  return undefined;
}

/**
 * WebP is three formats behind one signature, and each stores its size
 * differently.
 *
 * `VP8X` is the extended container and states the canvas directly. `VP8 ` is
 * lossy and hides the size in the keyframe header, 14 bits each. `VP8L` is
 * lossless and packs width-1 and height-1 into 28 bits with no byte alignment
 * at all.
 */
function webpDimensions(bytes: Buffer): Dimensions | undefined {
  if (bytes.length < 30) return undefined;
  const kind = bytes.subarray(12, 16).toString('latin1');

  if (kind === 'VP8X') {
    // Stored minus one, three bytes each, little-endian.
    const width = 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16));
    const height = 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16));
    return { width, height };
  }

  if (kind === 'VP8 ') {
    // The keyframe start code sits at 23..25; the dimensions follow it. The
    // top two bits of each are a scaling hint, not part of the value.
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return undefined;
    return {
      width: bytes.readUInt16LE(26) & 0x3fff,
      height: bytes.readUInt16LE(28) & 0x3fff,
    };
  }

  if (kind === 'VP8L') {
    if (bytes[20] !== 0x2f) return undefined;
    const packed = bytes.readUInt32LE(21);
    return {
      width: 1 + (packed & 0x3fff),
      height: 1 + ((packed >> 14) & 0x3fff),
    };
  }

  return undefined;
}
