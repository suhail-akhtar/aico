/**
 * What a codebase map is made of.
 *
 * @module codemap/types
 */

/** One source file, reduced to what an agent needs before opening it. */
export interface FileEntry {
  /** Path relative to the project root, forward slashes on every platform. */
  path: string;
  /**
   * The first sentence of the file's leading doc comment.
   *
   * The single highest-value line in the whole index. A file that says what it
   * is for answers most "where does X live" questions without being read, and
   * the alternative — inferring purpose from a filename — is how an agent ends
   * up reading six files to find the one it wanted.
   */
  purpose?: string;
  /** Exported/top-level symbol names, in declaration order. */
  symbols: string[];
  /** Bytes on disk, so an agent can tell a stub from a thousand-line module. */
  bytes: number;
  /** Last-modified time, which is what makes staleness detectable. */
  mtimeMs: number;
}

export interface CodeMap {
  /** Absolute project root the map describes. */
  root: string;
  /** When the map was built. */
  builtAt: number;
  /** Every indexed file, sorted by path. */
  files: FileEntry[];
  /**
   * Files found but not parsed for symbols.
   *
   * Recorded rather than dropped: knowing a `.sql` directory exists is useful
   * even when nothing inside it was understood, and silently omitting it would
   * make the map look like the project does not have one.
   */
  unparsed: number;
  /** Files skipped for being too large to be worth reading whole. */
  skipped: number;
}
