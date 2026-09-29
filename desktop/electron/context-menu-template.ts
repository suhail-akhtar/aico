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
 * useful to offer. In the built-in browser a page right-click also gets
 * Back / Forward / Reload, as in any browser.
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
  srcURL: string;
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
}

export interface MenuOptions {
  surface: 'app' | 'browser';
  /** Offer "Inspect element" (development builds, or the developer pref). */
  inspect: boolean;
  canGoBack?: boolean;
  canGoForward?: boolean;
}

export type MenuAction =
  | 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'pasteAsPlain' | 'selectAll'
  | 'addToDictionary' | 'openLinkExternal' | 'openLinkInBrowser' | 'openLinkNewTab' | 'copyLink'
  | 'copyImage' | 'copyImageAddress' | 'saveImage'
  | 'back' | 'forward' | 'reload' | 'inspect';

export type MenuSpec =
  | { type: 'separator' }
  | { type: 'item'; action: MenuAction; label: string; enabled?: boolean; accelerator?: string }
  /** Replace the misspelled word with `word`. */
  | { type: 'spelling'; word: string; label: string; enabled?: boolean };

const WEB_LINK = /^(https?|mailto):/i;

function item(action: MenuAction, label: string, enabled = true, accelerator?: string): MenuSpec {
  return { type: 'item', action, label, enabled, ...(accelerator ? { accelerator } : {}) };
}

export function buildContextMenuTemplate(p: MenuParams, o: MenuOptions): MenuSpec[] {
  const groups: MenuSpec[][] = [];
  const f = p.editFlags;
  const hasSelection = p.selectionText.trim().length > 0;
  const link = WEB_LINK.test(p.linkURL) ? p.linkURL : '';
  const image = p.mediaType === 'image' && p.srcURL ? p.srcURL : '';

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
    groups.push(o.surface === 'browser'
      ? [
        ...(web ? [item('openLinkNewTab', 'Open link in new tab')] : []),
        item('openLinkExternal', web ? 'Open link in your browser' : 'Open link'),
        item('copyLink', /^mailto:/i.test(link) ? 'Copy email address' : 'Copy link address'),
      ]
      : [
        item('openLinkExternal', 'Open link'),
        ...(web ? [item('openLinkInBrowser', 'Open in built-in browser')] : []),
        item('copyLink', /^mailto:/i.test(link) ? 'Copy email address' : 'Copy link address'),
      ]);
  }

  if (image) {
    groups.push([
      ...(p.hasImageContents ? [item('copyImage', 'Copy image')] : []),
      ...(/^(https?|data):/i.test(image) ? [item('copyImageAddress', 'Copy image address')] : []),
      item('saveImage', 'Save image as…'),
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

  // A plain right-click on a web page: navigation, as in any browser.
  if (o.surface === 'browser' && !p.isEditable && !hasSelection && !link && !image) {
    groups.push([
      item('back', 'Back', o.canGoBack ?? false),
      item('forward', 'Forward', o.canGoForward ?? false),
      item('reload', 'Reload'),
    ]);
  }

  const out: MenuSpec[] = [];
  for (const g of groups) {
    if (g.length === 0) continue;
    if (out.length) out.push({ type: 'separator' });
    out.push(...g);
  }
  // With inspection on it is always offered: in development, inspecting is
  // often the only reason to right-click.
  if (o.inspect) {
    if (out.length) out.push({ type: 'separator' });
    out.push(item('inspect', 'Inspect element'));
  }
  return out;
}
