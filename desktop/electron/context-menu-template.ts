/**
 * What a right-click menu should contain — decided from Chromium's
 * `context-menu` params, with no Electron in sight, so it can be unit-tested.
 * context-menu.ts turns the result into a native `Menu` and runs the actions.
 *
 * Electron draws no context menu of its own, so without this a right-click
 * in the composer could not paste and a misspelling could not be fixed.
 *
 * TWO SURFACES. In the app's own window the menu appears only where there is
 * something to act on — an editable field, a selection, a link, an image —
 * because everywhere else the interface either has its own menu (those call
 * `preventDefault`, and Chromium then sends no event at all) or nothing
 * useful to offer. In the built-in browser the menu is a browser's, as in
 * Chrome: links (new tab, background tab, save, copy), images and videos
 * (open, save, copy, picture-in-picture), selections (copy, search the web),
 * editable fields (spelling, undo … select all), and the page itself (back,
 * forward, reload, save, print, view source, inspect) — plus AICO: ask about
 * a link, an image or a selection, translate it, summarize the page. The
 * "Ask AICO" items only start a question in the copilot; nothing is sent to
 * a site.
 *
 * Groups are joined with separators only between non-empty groups, so the
 * menu never shows a separator at an edge or two in a row.
 *
 * @module desktop/electron/context-menu-template
 */

/** The subset of Electron's `ContextMenuParams` the template reads. */
export interface MenuParams {
  x?: number;
  y?: number;
  linkURL: string;
  linkText?: string;
  srcURL: string;
  pageURL?: string;
  mediaType: string;
  hasImageContents: boolean;
  isEditable: boolean;
  selectionText: string;
  misspelledWord: string;
  dictionarySuggestions: string[];
  editFlags: {
    canUndo: boolean; canRedo: boolean; canCut: boolean; canCopy: boolean;
    canPaste: boolean; canSelectAll: boolean; canEditRichly?: boolean;
  };
  mediaFlags?: { isLooping?: boolean; isControlsVisible?: boolean; canToggleControls?: boolean; canShowPictureInPicture?: boolean; isShowingPictureInPicture?: boolean; canLoop?: boolean };
}

export interface MenuOptions {
  surface: 'app' | 'browser';
  /** Offer "Inspect element" (development builds, or the developer pref). The browser always offers "Inspect". */
  inspect: boolean;
  canGoBack?: boolean;
  canGoForward?: boolean;
}

export type MenuAction =
  | 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'pasteAsPlain' | 'selectAll'
  | 'addToDictionary' | 'openLinkExternal' | 'openLinkInBrowser' | 'openLinkNewTab' | 'openLinkBackground' | 'copyLink' | 'saveLink'
  | 'copyImage' | 'copyImageAddress' | 'saveImage' | 'openImageNewTab'
  | 'pictureInPicture' | 'toggleLoop' | 'toggleControls' | 'openMediaNewTab' | 'copyMediaAddress' | 'saveMedia'
  | 'searchWeb' | 'askSelection' | 'translateSelection' | 'askLink' | 'askImage' | 'summarizePage'
  | 'back' | 'forward' | 'reload' | 'savePage' | 'print' | 'viewSource' | 'inspect';

export type MenuSpec =
  | { type: 'separator' }
  | { type: 'item'; action: MenuAction; label: string; enabled?: boolean; accelerator?: string; checked?: boolean }
  /** Replace the misspelled word with `word`. */
  | { type: 'spelling'; word: string; label: string; enabled?: boolean };

const WEB_LINK = /^(https?|mailto):/i;

/** A selection as it reads in a menu label: one line, cut to `max` characters. */
export function clipLabel(text: string, max = 28): string {
  const t = text.replace(/\s+/g, ' ').trim();
  // "&" marks an accelerator in native menu labels.
  const cut = t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
  return cut.replace(/&/g, '&&');
}

function item(action: MenuAction, label: string, enabled = true, accelerator?: string): MenuSpec {
  return { type: 'item', action, label, enabled, ...(accelerator ? { accelerator } : {}) };
}

export function buildContextMenuTemplate(p: MenuParams, o: MenuOptions): MenuSpec[] {
  const groups: MenuSpec[][] = [];
  const f = p.editFlags;
  const browser = o.surface === 'browser';
  const hasSelection = p.selectionText.trim().length > 0;
  const link = WEB_LINK.test(p.linkURL) ? p.linkURL : '';
  const image = p.mediaType === 'image' && p.srcURL ? p.srcURL : '';
  const media = (p.mediaType === 'video' || p.mediaType === 'audio') && p.srcURL ? p.srcURL : '';
  const video = p.mediaType === 'video';

  // Spelling first, as every editor does: the fix is what you right-clicked for.
  if (p.isEditable && p.misspelledWord) {
    const words = p.dictionarySuggestions.slice(0, 5);
    groups.push(words.length
      ? words.map(w => ({ type: 'spelling', word: w, label: w } as MenuSpec))
      : [{ type: 'spelling', word: '', label: 'No suggestions', enabled: false }]);
    groups.push([item('addToDictionary', 'Add to dictionary')]);
  }

  if (link) {
    const web = /^https?:/i.test(link);
    const mail = /^mailto:/i.test(link);
    if (browser) {
      groups.push([
        ...(web ? [item('openLinkNewTab', 'Open link in new tab'), item('openLinkBackground', 'Open link in new background tab')] : []),
        item('openLinkExternal', web ? 'Open link in your browser' : 'Open link'),
      ]);
      groups.push([
        ...(web ? [item('saveLink', 'Save link as…')] : []),
        item('copyLink', mail ? 'Copy email address' : 'Copy link address'),
      ]);
      if (web) groups.push([item('askLink', 'Ask AICO about this link')]);
    } else {
      groups.push([
        item('openLinkExternal', 'Open link'),
        ...(web ? [item('openLinkInBrowser', 'Open in built-in browser')] : []),
        item('copyLink', mail ? 'Copy email address' : 'Copy link address'),
      ]);
    }
  }

  if (image) {
    const fetchable = /^(https?|data|blob):/i.test(image);
    const copy = [
      ...(p.hasImageContents ? [item('copyImage', 'Copy image')] : []),
      ...(/^(https?|data):/i.test(image) ? [item('copyImageAddress', 'Copy image address')] : []),
    ];
    // The browser in Chrome's order; the app's own menu as it always was.
    groups.push(browser
      ? [...(/^https?:/i.test(image) ? [item('openImageNewTab', 'Open image in new tab')] : []), item('saveImage', 'Save image as…'), ...copy]
      : [...copy, item('saveImage', 'Save image as…')]);
    if (browser && fetchable) groups.push([item('askImage', 'Ask AICO about this image')]);
  }

  if (browser && media) {
    const mf = p.mediaFlags ?? {};
    const web = /^https?:/i.test(media);
    groups.push([
      ...(mf.canLoop !== false ? [{ ...item('toggleLoop', 'Loop'), checked: Boolean(mf.isLooping) } as MenuSpec] : []),
      ...(mf.canToggleControls ? [{ ...item('toggleControls', 'Show controls'), checked: Boolean(mf.isControlsVisible) } as MenuSpec] : []),
      ...(video && mf.canShowPictureInPicture !== false ? [{ ...item('pictureInPicture', 'Picture in picture'), checked: Boolean(mf.isShowingPictureInPicture) } as MenuSpec] : []),
    ]);
    groups.push([
      ...(web ? [item('openMediaNewTab', video ? 'Open video in new tab' : 'Open audio in new tab'), item('saveMedia', video ? 'Save video as…' : 'Save audio as…')] : []),
      ...(web ? [item('copyMediaAddress', video ? 'Copy video address' : 'Copy audio address')] : []),
    ]);
  }

  if (p.isEditable) {
    groups.push([item('undo', 'Undo', f.canUndo, 'CmdOrCtrl+Z'), item('redo', 'Redo', f.canRedo, 'CmdOrCtrl+Shift+Z')]);
    groups.push([
      item('cut', 'Cut', f.canCut, 'CmdOrCtrl+X'),
      item('copy', 'Copy', f.canCopy, 'CmdOrCtrl+C'),
      item('paste', 'Paste', f.canPaste, 'CmdOrCtrl+V'),
      ...(f.canEditRichly === false ? [] : [item('pasteAsPlain', 'Paste as plain text', f.canPaste, 'CmdOrCtrl+Shift+V')]),
    ]);
    groups.push([item('selectAll', 'Select all', f.canSelectAll, 'CmdOrCtrl+A')]);
  } else if (hasSelection) {
    groups.push([item('copy', 'Copy', f.canCopy !== false, 'CmdOrCtrl+C')]);
  }

  // A selection in a page: search it, ask about it, translate it.
  if (browser && hasSelection && !p.isEditable) {
    const q = clipLabel(p.selectionText);
    groups.push([item('searchWeb', `Search the web for “${q}”`)]);
    groups.push([item('askSelection', `Ask AICO about “${q}”`), item('translateSelection', 'Translate with AICO')]);
  }

  // A plain right-click on a web page: what any browser offers, and AICO.
  if (browser && !p.isEditable && !hasSelection && !link && !image && !media) {
    groups.push([
      item('back', 'Back', o.canGoBack ?? false, 'Alt+Left'),
      item('forward', 'Forward', o.canGoForward ?? false, 'Alt+Right'),
      item('reload', 'Reload', true, 'CmdOrCtrl+R'),
    ]);
    const web = /^https?:/i.test(p.pageURL ?? 'https:');
    groups.push([
      item('savePage', 'Save page as…', web, 'CmdOrCtrl+S'),
      item('print', 'Print…', true, 'CmdOrCtrl+P'),
    ]);
    groups.push([item('summarizePage', 'Summarize with AICO', web)]);
    groups.push([item('viewSource', 'View page source', web, 'CmdOrCtrl+U')]);
  }

  const out: MenuSpec[] = [];
  for (const g of groups) {
    if (g.length === 0) continue;
    if (out.length) out.push({ type: 'separator' });
    out.push(...g);
  }
  // In a browser "Inspect" is always there; in the app only with inspection on
  // (development builds, or the developer pref), where it is often the reason to right-click.
  if (browser || o.inspect) {
    if (out.length) out.push({ type: 'separator' });
    out.push(item('inspect', browser ? 'Inspect' : 'Inspect element'));
  }
  return out;
}

/** The copilot text for an "Ask AICO" / "Translate" / "Summarize" item: `send` goes straight away, otherwise it is put in the box to finish. */
export function askFor(action: MenuAction, p: Pick<MenuParams, 'linkURL' | 'linkText' | 'srcURL' | 'selectionText' | 'pageURL'>): { text: string; send: boolean } | null {
  const sel = p.selectionText.trim().slice(0, 4000);
  switch (action) {
    case 'askSelection': return { text: `About this text from the page:\n\n> ${sel.replace(/\n/g, '\n> ')}\n\n`, send: false };
    case 'translateSelection': return { text: `Translate this text from the page into English (or, if it is already English, into the language I name next), keeping its meaning and tone:\n\n> ${sel.replace(/\n/g, '\n> ')}`, send: true };
    case 'askLink': return { text: `About this link${p.linkText?.trim() ? ` ("${p.linkText.trim().slice(0, 120)}")` : ''}: ${p.linkURL}\n\n`, send: false };
    case 'askImage': return { text: `About this image on the page: ${p.srcURL.startsWith('data:') ? '(an embedded image)' : p.srcURL}\n\n`, send: false };
    case 'summarizePage': return { text: 'Summarize this page. Read it first with browser_read in reader mode (fall back to browser_text). A one-line gist, short sections under headings, then 3–6 key takeaways, and a "Source:" line.', send: true };
    default: return null;
  }
}

export const SEARCH_URL = 'https://www.google.com/search?q=';
