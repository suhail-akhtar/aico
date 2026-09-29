/**
 * The built-in browser's IPC contract — the shapes main and the renderer
 * exchange over `browser:*` channels. Both sides import these types; main
 * (`electron/browser*.ts`) is the only producer of state.
 *
 * Invoke channels (renderer → main, `window.aicoDesktop.invoke(channel, ...args)`):
 *
 *   browser:state                              → BrowserState
 *   browser:history:list    (opts?: HistoryListOptions) → HistoryEntry[]
 *   browser:history:remove  (url)
 *   browser:history:clear   (sinceMs?)          removes visits at or after sinceMs (all when omitted)
 *   browser:bookmarks:list                      → Bookmark[]
 *   browser:bookmarks:add   (BookmarkInput)     → Bookmark
 *   browser:bookmarks:remove (url)
 *   browser:downloads:list                      → DownloadItem[]
 *   browser:downloads:open  (id) / :show (id) / :cancel (id) / :retry (id) / :clear ()
 *   browser:find            (FindRequest)       → FindResult
 *   browser:findStop        ()
 *   browser:print           ()
 *   browser:savePdf         ()                  → string | null (the saved path)
 *   browser:siteInfo        ()                  → SiteInfo
 *   browser:blocking:set    (BlockingSet)       → BrowserState['blocking']
 *   browser:mute            (tabId, muted)
 *   browser:read            (ReadRequest)       → PageRead
 *   browser:insights        ()                  → PageInsights
 *   browser:forms           ()                  → FormModel[]
 *   browser:agentStop       () / browser:agentResume ()
 *   browser:permissionAnswer (id, allow, remember)
 *   browser:dialogAnswer    (id, accept, text?)
 *   browser:authAnswer      (id, creds | null)
 *   browser:confirmAnswer   (id, allow)
 *   browser:certAnswer      (tabId, proceed: false)   only "go back" exists — a bad certificate is never accepted
 *
 * Earlier channels stay: browser:tabs, :open, :newTab, :close, :select, :back,
 * :forward, :reload, :stop, :zoom, :devtools, :external, :setBounds,
 * :screenshot, :handoffDone, :clearData, :console, :network.
 *
 * Events (main → renderer, `window.aicoDesktop.on(channel, fn)`): see
 * `BrowserEvents` below. `browser:tabs` (TabInfo[]), `browser:handoff`,
 * `browser:agent-active`, `browser:error` and `browser:focus-address` are
 * still sent for the earlier interface.
 *
 * @module desktop/shared/browser-types
 */

export type SecurityState = 'secure' | 'insecure' | 'error' | 'internal';

export interface TabState {
  id: string;
  url: string;
  title: string;
  favicon?: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  audible: boolean;
  muted: boolean;
  zoom: number;
  security: SecurityState;
  /** Tracker requests blocked since this tab's last main-frame navigation. */
  trackersBlocked: number;
  /** The agent acted on this tab in the last ~2 s. */
  agentActive: boolean;
  /** A CAPTCHA / "verify you are human" check is on the page: the agent will not act here. */
  humanCheck: boolean;
  /** The main frame failed to load (DNS, TLS, refused…). A certificate error has code ≤ -200 and > -300. */
  error?: { code: number; description: string; url: string };
  /** Extension: pop-ups blocked on this page because no click or key press opened them. */
  popupsBlocked?: number;
}

export interface BrowserState {
  activeId: string | null;
  tabs: TabState[];
  blocking: { enabled: boolean };
  /** Extension: the user pressed Stop / Take over — agent browser tools refuse until resumed. */
  agentStopped?: boolean;
}

export interface HistoryListOptions { query?: string; limit?: number }

export interface HistoryEntry {
  url: string;
  title: string;
  favicon?: string;
  visits: number;
  lastVisit: number;
}

export interface Bookmark {
  url: string;
  title: string;
  favicon?: string;
  addedAt: number;
  folder?: string;
}

export interface BookmarkInput { url: string; title: string; favicon?: string; folder?: string }

export type DownloadState = 'progressing' | 'completed' | 'cancelled' | 'interrupted' | 'awaiting-confirmation';

export interface DownloadItem {
  id: string;
  url: string;
  filename: string;
  path: string;
  state: DownloadState;
  received: number;
  total: number;
  startedAt: number;
  byAgent: boolean;
}

export interface FindRequest { text: string; forward?: boolean; findNext?: boolean }
export interface FindResult { matches: number; active: number }

export type PermissionSetting = 'allow' | 'deny' | 'ask';

export interface SiteInfo {
  url: string;
  origin: string;
  security: SecurityState;
  certificate?: { issuer: string; subject: string; validTo: number };
  permissions: Record<string, PermissionSetting>;
  trackersBlocked: number;
  /** Tracker hosts blocked on this page. */
  trackers: string[];
  /**
   * True when tracker blocking applies to this origin: blocking is on and the
   * origin is not on the allow list. Toggle with browser:blocking:set
   * { allowOrigin } (stop blocking here) / { disallowOrigin } (block here again).
   */
  blockingAllowedHere: boolean;
}

export interface BlockingSet { enabled?: boolean; allowOrigin?: string; disallowOrigin?: string }

export interface ReadRequest { mode: 'reader' | 'full'; maxChars?: number }

export interface PageRead {
  url: string;
  title: string;
  byline?: string;
  markdown: string;
  words: number;
  headings: Array<{ level: number; text: string }>;
  links: Array<{ text: string; href: string }>;
  /** Extension: images in the read content. */
  images?: Array<{ alt: string; src: string }>;
  /** Extension: the Markdown was cut at maxChars. */
  truncated?: boolean;
  /** Extension: why the page could not be read as HTML (PDF viewer, image, plain text…). */
  note?: string;
}

export interface PageInsights {
  url: string;
  title: string;
  /** article | product | search-results | listing | login | form | checkout | video | docs | home | error | pdf | page */
  kind: string;
  summaryHints: string[];
  mainAction?: string;
  forms: number;
  loginWall: boolean;
  paywall: boolean;
  cookieBanner: boolean;
  humanCheck: boolean;
  security: SecurityState;
  trackersBlocked: number;
}

export type SensitiveKind = 'password' | 'card' | 'cvv' | 'otp';

export interface FormFieldOption { value: string; label: string; selected: boolean }

export interface FormField {
  /** Element ref usable with browser_click / browser_type / browser_fill. */
  ref: string;
  label: string;
  name: string;
  /** input type, or select / textarea / contenteditable / radio-group. */
  type: string;
  required: boolean;
  value: string;
  checked?: boolean;
  options?: FormFieldOption[];
  placeholder?: string;
  disabled?: boolean;
  /** The browser's own validation message, when the field is currently invalid. */
  invalid?: string;
  /** Credentials / payment / one-time codes: the agent never fills these. */
  sensitive?: SensitiveKind;
}

export interface FormModel {
  index: number;
  ref?: string;
  name?: string;
  action: string;
  method: string;
  fields: FormField[];
  submit: Array<{ ref: string; label: string }>;
  /** In a same-origin frame, its URL. */
  frame?: string;
}

export type ExtractKind = 'links' | 'tables' | 'prices' | 'contacts' | 'outline' | 'metadata';

// ── Events ──

export interface PermissionRequest { id: string; tabId: string; origin: string; permission: string }

export type DialogType = 'alert' | 'confirm' | 'prompt' | 'beforeunload';
export interface DialogRequest { id: string; tabId: string; type: DialogType; message: string; defaultPrompt?: string; byAgent: boolean }

export interface AuthRequest { id: string; tabId: string; host: string; realm?: string }

export interface ConfirmRequest { id: string; kind: 'upload' | 'download'; title: string; detail: string; files?: string[]; origin: string }

export interface AgentEvent { tabId: string; action: string; label?: string; status: 'start' | 'done' | 'error' | 'blocked'; detail?: string }

export interface BrowserEvents {
  'browser:state': BrowserState;
  'browser:permission': PermissionRequest;
  'browser:dialog': DialogRequest;
  'browser:auth': AuthRequest;
  'browser:confirm': ConfirmRequest;
  'browser:download': DownloadItem;
  'browser:agent': AgentEvent;
  'browser:found': FindResult;
}
