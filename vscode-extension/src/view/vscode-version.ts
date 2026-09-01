/**
 * Which side bar the panel is allowed to live in.
 *
 * Deliberately free of any `vscode` import, so it can be tested without an
 * editor. That is not fastidiousness: this function decides which of two
 * declared view containers is real, and the consequence of getting it wrong is
 * not a broken panel but a *displaced* one — declaring `secondarySidebar` on a
 * VS Code that predates it pushes other extensions' views around
 * (`QwenLM/qwen-code#2432`). A wrong answer here breaks somebody else's editor.
 *
 * @module view/vscode-version
 */

/** The first VS Code that can put a view container in the Secondary Side Bar. */
export const SECONDARY_SIDEBAR_SINCE = { major: 1, minor: 106 } as const;

/**
 * Whether this VS Code understands `viewsContainers.secondarySidebar`.
 *
 * Parsed rather than feature-detected, because there is nothing to detect: the
 * contribution is read from the manifest at install time, long before any code
 * of ours runs. A version string is the only signal available.
 *
 * Unparseable input answers `true`, and that is the deliberate choice. Forks and
 * insider builds carry versions this does not model, and they are current
 * builds — treating "I do not recognise this" as "this is ancient" would put
 * every VSCodium and every Insiders user in the wrong sidebar for ever, to guard
 * against a build older than 1.106 that reports something exotic.
 */
export function supportsSecondarySidebar(version: string): boolean {
  const match = /^(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return true;

  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return true;

  if (major !== SECONDARY_SIDEBAR_SINCE.major) return major > SECONDARY_SIDEBAR_SINCE.major;
  return minor >= SECONDARY_SIDEBAR_SINCE.minor;
}
