/**
 * The design board viewer's data side: the board itself, and each screen as
 * the self-contained document the frames show (ADR 0037).
 *
 * Screens and their shared files come through the engine's `artifacts/file`
 * route (which checks they are inside the chat's artifacts folder) and are
 * composed by `shared/ui/board/board-compose` — stylesheets, scripts, fonts
 * and pictures inlined, plus the link-to-message script for live frames.
 * One fetch per file per board version: a stylesheet ten screens share is
 * read once, and a new version (the agent wrote again) starts a fresh cache.
 *
 * How a client frames a document is a seam (`FrameHost`): the browser uses a
 * `srcdoc` frame; the desktop registers the document as an in-memory page on
 * its isolated preview origin (`aico://preview`, ADR 0020), because a srcdoc
 * frame there inherits the window's CSP and would run no script.
 *
 * @module web/components/board/board-docs
 */

import { api } from '../../api';
import { bytesToBase64, boardMime, composeScreen, type BoardFileReader } from '../../../../shared/ui/board/board-compose';
import type { BoardFrame } from '../../../../shared/ui/board/board-model';

/** How this client puts a composed document in a frame: a URL to frame, or null for srcdoc. */
export type FrameHost = (html: string) => Promise<string>;

/** Pictures and fonts above this are left as a missing asset rather than bloating every frame. */
const MAX_INLINE_BYTES = 3 * 1024 * 1024;

export interface BoardDocs {
  /** The screen as a document for a live frame or Play (inlined, navigation script, CSP). */
  live(frame: BoardFrame): Promise<string>;
  /** The screen as one standalone file to download (inlined, no script added, no CSP). */
  standalone(frame: BoardFrame): Promise<string>;
}

/** Documents for the board whose folder is `dir` (relative to the artifacts folder). */
export function boardDocs(sessionId: string, dir: string): BoardDocs {
  const files = new Map<string, Promise<Blob | undefined>>();
  const fetchFile = (rel: string): Promise<Blob | undefined> => {
    let p = files.get(rel);
    if (!p) {
      p = api.artifactFile(sessionId, { path: dir ? `${dir}/${rel}` : rel }).then(b => b, () => undefined);
      files.set(rel, p);
    }
    return p;
  };
  const reader: BoardFileReader = {
    text: async (rel) => { const b = await fetchFile(rel); return b ? b.text() : undefined; },
    dataUrl: async (rel) => {
      const b = await fetchFile(rel);
      if (!b || b.size > MAX_INLINE_BYTES) return undefined;
      return `data:${boardMime(rel)};base64,${bytesToBase64(new Uint8Array(await b.arrayBuffer()))}`;
    },
  };
  const cache = new Map<string, Promise<string>>();
  const make = (frame: BoardFrame, live: boolean): Promise<string> => {
    const key = `${live ? 'L' : 'S'}:${frame.file}`;
    let p = cache.get(key);
    if (!p) {
      p = reader.text(frame.file).then(html => {
        if (html === undefined) throw new Error(`${frame.file} is missing from the board folder`);
        return composeScreen(html, frame.file, reader, { navigation: live, csp: live });
      });
      p.catch(() => cache.delete(key));
      cache.set(key, p);
    }
    return p;
  };
  return { live: f => make(f, true), standalone: f => make(f, false) };
}

/** Save a blob under a name through the browser's own download. */
export function downloadBlob(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
