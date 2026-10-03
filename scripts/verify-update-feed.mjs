/**
 * Proves a GitHub release can update installed copies of AICO Desktop before
 * anyone is told about it.
 *
 *   node scripts/verify-update-feed.mjs v0.37.1 [--repo owner/name] [--no-hash]
 *
 * For each feed (`latest.yml` for Windows, `latest-linux.yml` for the
 * AppImage and deb) it checks that the feed announces this tag's version,
 * names assets that are attached under exactly those names, and — unless
 * `--no-hash` — downloads each named installer and compares its sha512 with
 * the feed. A mismatch means the feed and the installer came from different
 * builds, and every installed copy would reject the download.
 *
 * WHY a separate step: the Desktop workflow builds Windows and Linux in
 * parallel jobs that each upload with `--clobber`; a re-run can replace one
 * file and not its partner. The workflow runs this after both uploads and
 * only then publishes the (draft) release, so installed copies never see a
 * release whose feed is missing or wrong. Uses `gh`, so it needs GH_TOKEN in
 * CI or a signed-in gh locally. Exit 1 on any problem.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseUpdateFeed, checkUpdateFeed } from './lib/update-feed.mjs';

const args = process.argv.slice(2);
const tag = args.find(a => /^v\d+\.\d+\.\d+/.test(a));
const repoAt = args.indexOf('--repo');
const repo = repoAt >= 0 ? args[repoAt + 1] : 'suhail-akhtar/aico';
const hash = !args.includes('--no-hash');
if (!tag) { console.error('usage: node scripts/verify-update-feed.mjs vX.Y.Z [--repo owner/name] [--no-hash]'); process.exit(2); }
const version = tag.slice(1);

function gh(argv) {
  const r = spawnSync('gh', argv, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`gh ${argv.slice(0, 3).join(' ')} failed: ${(r.stderr || r.stdout || '').trim().split('\n')[0]}`);
  return r.stdout;
}

function sha512(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha512');
    fs.createReadStream(file).on('data', d => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('base64')));
  });
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-feed-'));
const assets = JSON.parse(gh(['release', 'view', tag, '--repo', repo, '--json', 'assets'])).assets.map(a => ({ name: a.name, size: a.size }));
let problems = 0;
try {
  for (const feedName of ['latest.yml', 'latest-linux.yml']) {
    if (!assets.some(a => a.name === feedName)) { console.log(`FAIL  ${feedName}: not attached to ${tag}`); problems++; continue; }
    gh(['release', 'download', tag, '--repo', repo, '--pattern', feedName, '--dir', dir, '--clobber']);
    let feed;
    try { feed = parseUpdateFeed(fs.readFileSync(path.join(dir, feedName), 'utf8')); }
    catch (err) { console.log(`FAIL  ${feedName}: ${err.message}`); problems++; continue; }
    const sums = {};
    if (hash) {
      for (const f of feed.files) {
        if (!assets.some(a => a.name === f.url)) continue; // reported by checkUpdateFeed
        gh(['release', 'download', tag, '--repo', repo, '--pattern', f.url, '--dir', dir, '--clobber']);
        const file = path.join(dir, f.url);
        sums[f.url] = await sha512(file);
        fs.rmSync(file, { force: true });
      }
    }
    const found = checkUpdateFeed(feed, assets, { version, sha512: sums });
    for (const p of found) console.log(`FAIL  ${feedName}: ${p}`);
    if (!found.length) console.log(`ok    ${feedName}: ${feed.files.map(f => f.url).join(', ')}${hash ? ' (sha512 verified)' : ' (names and sizes)'}`);
    problems += found.length;
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
if (problems) { console.log(`\n${tag}: ${problems} problem(s) — installed copies could not update from this release. Do not publish it.`); process.exit(1); }
console.log(`\n${tag}: installed copies can update from this release.`);
