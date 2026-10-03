/**
 * Reads an electron-builder update feed (`latest.yml`, `latest-linux.yml`)
 * and checks it against what a GitHub release actually holds.
 *
 * WHY. Installed copies of AICO Desktop update by reading that feed and
 * downloading the file it names (electron-updater). The feed is only useful
 * if its `path`/`url` names an asset that exists under exactly that name, and
 * its `size`/`sha512` describe that asset's bytes — a feed from one build and
 * an installer from another (a re-run that clobbered one but not the other)
 * makes every installed copy fail with a checksum error. The 0.37.0 release
 * also went "Latest" ~24 minutes before its feed was attached, so a check in
 * that window failed. The release is now published by the Desktop workflow
 * only after `scripts/verify-update-feed.mjs` passes these checks.
 *
 * Pure (no fs, no network): `scripts/verify-update-feed.mjs` (CI, hashes the
 * real downloads), `scripts/release.mjs` (names and sizes only) and the
 * desktop unit tests all use it.
 *
 * Deliberately NOT a YAML library: electron-builder writes one fixed, flat
 * shape (top-level scalars plus a `files:` list of maps). Anything else is
 * reported as a problem rather than guessed at.
 */

/**
 * @typedef {{ url: string; sha512: string; size?: number; blockMapSize?: number }} FeedFile
 * @typedef {{ version: string; path?: string; sha512?: string; releaseDate?: string; files: FeedFile[] }} UpdateFeed
 */

const unquote = (v) => {
  const t = v.trim();
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) return t.slice(1, -1);
  return t;
};
const scalar = (key, v) => (key === 'size' || key === 'blockMapSize' ? Number(unquote(v)) : unquote(v));

/**
 * Parse the feed text. Throws with the line number on a shape it does not know.
 * @param {string} text
 * @returns {UpdateFeed}
 */
export function parseUpdateFeed(text) {
  /** @type {Record<string, unknown>} */
  const top = {};
  /** @type {FeedFile[]} */
  const files = [];
  let inFiles = false;
  /** @type {Record<string, unknown> | null} */
  let cur = null;
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  lines.forEach((line, i) => {
    if (!line.trim() || line.trim().startsWith('#')) return;
    let m;
    if ((m = /^([A-Za-z][\w]*):\s*(.*)$/.exec(line))) {
      inFiles = m[1] === 'files' && m[2].trim() === '';
      cur = null;
      if (!inFiles) top[m[1]] = scalar(m[1], m[2]);
      return;
    }
    if (inFiles && (m = /^\s+-\s+([A-Za-z][\w]*):\s*(.*)$/.exec(line))) {
      cur = { [m[1]]: scalar(m[1], m[2]) };
      files.push(/** @type {FeedFile} */ (cur));
      return;
    }
    if (inFiles && cur && (m = /^\s+([A-Za-z][\w]*):\s*(.*)$/.exec(line))) {
      cur[m[1]] = scalar(m[1], m[2]);
      return;
    }
    throw new Error(`update feed line ${i + 1} is not in the shape electron-builder writes: ${line.trim().slice(0, 80)}`);
  });
  if (typeof top.version !== 'string' || !top.version) throw new Error('update feed has no version');
  return { ...top, version: top.version, files };
}

/**
 * What is wrong with this feed for this release. Empty means installed copies
 * can find, download and verify the update.
 *
 * @param {UpdateFeed} feed
 * @param {{ name: string; size?: number }[]} assets   the release's assets
 * @param {{ version?: string; sha512?: Record<string, string> }} [opts]
 *        `version`: what the feed must announce; `sha512`: base64 sha512 of
 *        downloaded assets by name (only those are hash-checked)
 * @returns {string[]}
 */
export function checkUpdateFeed(feed, assets, opts = {}) {
  const problems = [];
  const byName = new Map(assets.map(a => [a.name, a]));
  if (opts.version && feed.version !== opts.version) problems.push(`feed announces ${feed.version}, the release is ${opts.version}`);
  if (!feed.files.length) problems.push('feed lists no files');
  for (const f of feed.files) {
    if (!f.url) { problems.push('a feed file has no url'); continue; }
    // electron-updater joins `url` onto .../releases/download/<tag>/ — the name must match byte for byte.
    if (/[\s/\\]/.test(f.url)) problems.push(`${f.url}: a feed url must be a bare asset name (no spaces or slashes)`);
    const a = byName.get(f.url);
    if (!a) { problems.push(`${f.url}: named by the feed but not attached to the release`); continue; }
    if (!f.sha512) problems.push(`${f.url}: no sha512 in the feed`);
    if (typeof f.size === 'number' && typeof a.size === 'number' && f.size !== a.size) problems.push(`${f.url}: feed says ${f.size} bytes, the release asset is ${a.size} — they come from different builds`);
    const got = opts.sha512?.[f.url];
    if (got !== undefined && f.sha512 && got !== f.sha512) problems.push(`${f.url}: sha512 of the uploaded file does not match the feed — they come from different builds`);
  }
  // The legacy top-level fields must agree with the first file (older updaters read them).
  if (feed.path !== undefined) {
    const first = feed.files[0];
    if (first && feed.path !== first.url) problems.push(`top-level path ${feed.path} is not the first file ${first.url}`);
    if (first && feed.sha512 !== undefined && feed.sha512 !== first.sha512) problems.push('top-level sha512 differs from the first file');
  }
  return problems;
}
