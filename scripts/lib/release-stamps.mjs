/**
 * Where a release writes its version outside package.json, in one table.
 *
 * `scripts/check-standards.mjs` reads these patterns to verify a release and
 * `scripts/release.mjs` uses the same ones to write it. They cannot disagree:
 * if a new page grows a new kind of stamp, add one row here and both the
 * bump and the check learn it together. Before this table the list lived in
 * a memory note and a person's head, and `docs/install.html` still showed a
 * 0.7 example and `docs/vscode.html` a 0.6.4 VSIX, twenty releases later.
 *
 * Each rule's first capture group is the version text; `want` picks which
 * version it must equal: the engine version, its minor (`0.28`), or the VS
 * Code extension's own version (it is versioned separately).
 *
 * Deliberately NOT a bare version number: "Releases before 0.28.0 were
 * published under the MIT License" must never be rewritten by a bump.
 */

/** Files that carry stamps: README, SECURITY.md (supported line) and every top-level website page. */
export const STAMP_FILES = (tracked) => ['README.md', 'SECURITY.md', ...tracked.filter(f => /^docs\/[^/]+\.html$/.test(f))];

/**
 * A rule with `only` applies to the files it matches; the rest apply to all.
 * @returns {{re: RegExp, want: 'version'|'minor'|'vsix', what: string, only?: RegExp}[]}
 */
export function stampRules() {
  return [
    // SECURITY.md: the supported line is the latest minor.
    { re: /`(\d+\.\d+)\.x`/g, want: 'minor', what: 'supported release line', only: /^SECURITY\.md$/ },
    { re: /\| (\d+\.\d+)\.x \|/g, want: 'minor', what: 'supported-versions table row', only: /^SECURITY\.md$/ },
    { re: /\| < (\d+\.\d+) \|/g, want: 'minor', what: 'unsupported-versions table row', only: /^SECURITY\.md$/ },
    { re: /`release\/v(\d+\.\d+)`/g, want: 'minor', what: 'supported release branch', only: /^SECURITY\.md$/ },
    { re: /releases\/download\/v(\d+\.\d+\.\d+)\//g, want: 'version', what: 'release download URL tag' },
    { re: /AICO-Setup-(\d+\.\d+\.\d+)-win-x64\.exe/g, want: 'version', what: 'Windows installer name' },
    { re: /AICO-(\d+\.\d+\.\d+)-linux-x64\.(?:AppImage|deb)/g, want: 'version', what: 'Linux package name' },
    { re: /#v(\d+\.\d+\.\d+)\b/g, want: 'version', what: 'install pin (#vX.Y.Z)' },
    { re: /#release\/v(\d+\.\d+)\b/g, want: 'minor', what: 'release branch pin' },
    { re: /\bThe (\d+\.\d+) line\b/g, want: 'minor', what: 'release line example' },
    { re: /<span class="ver">v(\d+\.\d+\.\d+)<\/span>/g, want: 'version', what: 'website version badge' },
    { re: /"softwareVersion":\s*"(\d+\.\d+\.\d+)"/g, want: 'version', what: 'structured-data softwareVersion' },
    { re: /aico-vscode-(\d+\.\d+\.\d+)\.vsix/g, want: 'vsix', what: 'VS Code extension file name (vscode-extension/package.json)' },
  ];
}

/** The value a rule must carry. `vsix` may be null (then VSIX stamps are not checked). */
export function wanted(rule, { version, vsix }) {
  if (rule.want === 'minor') return version.split('.').slice(0, 2).join('.');
  if (rule.want === 'vsix') return vsix;
  return version;
}

/** The rules that apply to one file. */
export function rulesFor(rel) {
  return stampRules().filter(rule => !rule.only || rule.only.test(rel));
}

/** Rewrite every stamp in `text` (the content of `rel`) to the target versions. */
export function applyStamps(text, targets, rel) {
  let out = text;
  for (const rule of rulesFor(rel)) {
    const want = wanted(rule, targets);
    if (!want) continue;
    out = out.replace(rule.re, (match, found) => match.replace(found, want));
  }
  return out;
}

/** README must carry these direct download links for a release. */
export function requiredDownloads(version) {
  return [`AICO-Setup-${version}-win-x64.exe`, `AICO-${version}-linux-x64.AppImage`, `AICO-${version}-linux-x64.deb`]
    .map(name => `releases/download/v${version}/${name}`);
}
