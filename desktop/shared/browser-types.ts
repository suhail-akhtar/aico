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
 *   browser:bookmarks:list                      → Bookmark[] (every bookmark, flattened)
 *   browser:bookmarks:add   (BookmarkInput)     → Bookmark (updates the first one with that URL, else adds)
 *   browser:bookmarks:remove (url)              removes every bookmark with that URL
 *   browser:bookmarks:get / :create / :update / :move / :delete / :undo / :sort / :addTabs /
 *     :barMode / :menu / :importSources / :import / :export — the tree (see electron/browser-bookmarks.ts);
 *     every change is pushed as `browser:bookmarks` (BookmarksSnapshot)
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
 *   browser:setBounds       (rect | null, show) → { still?: PageStill }   hiding a page on screen captures it first
 *   browser:still           ()                  → PageStill | null   the active tab's last still; never captures
 *   browser:overlay:*       the floating copilot's view — see shared/copilot-float.ts
 *   browser:move (id, toIndex) / :pin (id, on) / :duplicate (id) / :reopenClosed () / :closedTabs ()
 *   browser:tabMenu (id, { bookmarked }) → the action picked in the tab's native menu
 *   browser:windowFullscreen (on?) / :isWindowFullscreen ()   events: win:fullscreen, browser:htmlFullscreen
 *   browser:pageSignals ()                     → PageSignals | null (shared/page-signals.ts)
 *   browser:autofill:get / :set / :status / :scan / :fill   the autofill profile (electron/browser-autofill-store.ts)
 *   browser:ask event                          a context-menu "Ask AICO" for the copilot ({ kind, text, url })
 *   browser:learn:*                            browsing intelligence — see shared/browser-learn-types.ts
 *   — tabs, session restore and full screen: electron/browser-session.ts
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
  /** Shields: third-party requests that had their cookies removed on this page. */
  cookiesBlocked?: number;
  /** Shields: this page was upgraded from http:// to https://. */
  httpsUpgraded?: boolean;
  /** Shields: the https:// upgrade failed — the interface offers the http:// page or going back. */
  httpsFallback?: HttpsFallback;
  /** Protected browsing: the page looks deceptive (block: interstitial; warn: bar). The agent will not act on it. */
  threat?: ThreatInfo;
  /** Tabs: pinned (icon-only, always first). */
  pinned?: boolean;
  /** Prompt-injection guard: what was hidden or flagged on this page when the agent read it. */
  injectionGuard?: InjectionGuardInfo;
}

export interface HttpsFallback { httpUrl: string; httpsUrl: string; reason: string }

export interface ThreatInfo {
  level: 'block' | 'warn';
  url: string;
  host: string;
  score: number;
  reasons: Array<{ id: string; label: string; weight: number }>;
  brand?: string;
  /** 'url' when judged (and blocked) before loading; 'page' after looking at the page. */
  stage: 'url' | 'page';
  /** The user chose "Continue anyway" for this page. */
  proceeded?: boolean;
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

/** A bookmark as a flat list sees it: its node id, the folder it is in and that folder's path. */
export interface Bookmark {
  url: string;
  title: string;
  favicon?: string;
  addedAt: number;
  /** The folder path, "Bookmarks bar/Work". */
  folder?: string;
  id?: string;
  parentId?: string;
}

/** `folder` is a path under the bookmarks bar ("Work/Reading"), created if missing; `parentId` names a folder outright. */
export interface BookmarkInput { url: string; title: string; favicon?: string; folder?: string; parentId?: string; index?: number }

/** One node of the bookmark tree: a bookmark has a `url`, a folder has `children`. */
export interface BookmarkNode {
  id: string;
  title: string;
  addedAt: number;
  url?: string;
  favicon?: string;
  children?: BookmarkNode[];
}

/** The whole tree. `roots` is always [Bookmarks bar, Other bookmarks] (ids "bar" and "other"). */
export interface BookmarkTree { version: 2; roots: BookmarkNode[] }

export type BookmarkBarMode = 'always' | 'newtab' | 'never';

export interface BookmarksSnapshot { tree: BookmarkTree; bar: BookmarkBarMode }

/** A place bookmarks can be imported from: a Chromium profile that was found, or an HTML file to pick. */
export interface BookmarkImportSource { id: string; browser: string; profile?: string; kind: 'chromium' | 'html'; count?: number }

export interface BookmarkImportResult { folderId: string; title: string; count: number; skipped: number }

/** One entry of a native menu shown for a bookmark (`browser:bookmarks:menu`); the picked id comes back. */
export type BookmarkMenuItem = { id: string; label: string; enabled?: boolean; checked?: boolean; accelerator?: string } | { type: 'separator' };

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
  /** Prompt-injection guard: passages dropped because a person cannot see them (browser-page.ts). */
  concealed?: ConcealedReport;
}

/** What the page script dropped as invisible: how many, how many by a trick (not plain display:none), and samples. */
export interface ConcealedReport { count: number; tricks: number; samples: Array<{ reason: string; text: string }> }

/** Prompt-injection guard, per tab and page (shared/injection-guard.ts): shown in Shields. */
export interface InjectionGuardInfo {
  url: string;
  hidden: number;
  flagged: number;
  snippets: Array<{ text: string; hidden: boolean }>;
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
  /** Prompt-injection guard counts for this page, once the agent has read it. */
  injectionGuard?: { hidden: number; flagged: number };
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

export interface ConfirmRequest {
  /** `commit`: the agent is about to buy, pay, book, send or delete (browser-commit-gate.ts). */
  id: string; kind: 'upload' | 'download' | 'tabs' | 'commit'; title: string; detail: string; files?: string[]; origin: string;
  /** Extension: button labels ("Keep" / "Discard") and a danger styling for risky downloads. */
  okLabel?: string; cancelLabel?: string; danger?: boolean;
}

/** The page as it was when something covered it, for the interface to draw in its place. Device pixels. */
export interface PageStill { tabId: string; dataUrl: string; width: number; height: number }

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

// ── Shields, protected browsing and insights (electron/browser-privacy.ts) ──
//
//   browser:shield:site      ()                      → ShieldSite   (the active tab)
//   browser:shield:settings  ()                      → ShieldSettingsView
//   browser:shield:set       (ShieldSet)             → ShieldSettingsView
//   browser:shield:proceed   (tabId)                 continue past "Deceptive site ahead" once
//   browser:shield:safety    (tabId)                 back to safety (leave the flagged page)
//   browser:shield:trust     (tabId)                 stop flagging this site (a false alarm)
//   browser:shield:http      (tabId)                 open the http:// page after a failed upgrade (remembered)
//   browser:insights:summary (days: 7 | 30)          → InsightsSummary
//   browser:insights:clear   ()
//   browser:permissions:list ()                      → SitePermissions[]
//   browser:permissions:reset (origin?)              all of a site's permissions (every site when omitted)
//
// Event: browser:threat (ThreatEvent) — a page was flagged; the interface may
// ask the copilot to explain it when `autoCheck` is on.

export interface ShieldTracker { host: string; company: string; category: 'ads' | 'analytics' | 'social' | 'fingerprinting' | 'session-replay'; count: number }

export interface ShieldSite {
  url: string;
  origin: string;
  site: string;
  /** Tracker blocking applies here (global switch on and the origin not allowed). */
  trackersOn: boolean;
  cookiesOn: boolean;
  httpsOn: boolean;
  trackersBlocked: number;
  trackers: ShieldTracker[];
  companies: Array<{ company: string; count: number; category: ShieldTracker['category'] }>;
  fingerprinting: number;
  cookiesBlocked: number;
  httpsUpgraded: boolean;
  popupsBlocked: number;
  notificationsBlocked: number;
  gpc: boolean;
  threat?: ThreatInfo;
  /** The user said this site is not deceptive. */
  trusted: boolean;
}

export interface ShieldSettingsView {
  trackers: boolean;
  cookies3p: boolean;
  httpsFirst: boolean;
  gpc: boolean;
  protection: { heuristics: boolean; list: boolean; autoCheck: boolean; injectionGuard: boolean };
  notificationsAsk: boolean;
  insights: boolean;
  clearOnExit: { cookies: boolean; cache: boolean; history: boolean; insights: boolean };
  /** Per-site exceptions: sites allowed third-party cookies / not upgraded / trusted / trackers allowed (origins). */
  exceptions: Array<{ site: string; cookies3p?: boolean; httpsFirst?: boolean; trusted?: boolean; http?: boolean; trackers?: boolean }>;
  list: { hosts: number; updatedAt: number; source: string; error?: string };
}

export interface ShieldSet {
  /** Per-site: omit a field to leave it. */
  site?: string;
  cookies3p?: boolean;
  httpsFirst?: boolean;
  trusted?: boolean;
  /** Remove every exception for `site`. */
  reset?: boolean;
  /** Global switches. */
  global?: Partial<Omit<ShieldSettingsView, 'exceptions' | 'list' | 'trackers'>>;
}

export interface ThreatEvent { tabId: string; threat: ThreatInfo; autoCheck: boolean; prompt: string }

export interface InsightsSummary {
  range: number;
  days: Array<{ day: string; trackers: number; ms: number; cookies: number; upgrades: number; pages: number }>;
  totals: { trackers: number; cookies: number; upgrades: number; warned: number; downloads: number; ms: number; visits: number; pages: number; sites: number };
  topSites: Array<{ site: string; ms: number; visits: number; pages: number; trackers: number }>;
  topCompanies: Array<{ company: string; count: number }>;
  since: string;
  enabled: boolean;
}

export interface SitePermissions { origin: string; permissions: Record<string, 'allow' | 'deny'> }

// ── Import centre and password vault (electron/browser-import*.ts, browser-vault*.ts) ──

export type ImportPart = 'bookmarks' | 'history' | 'addresses';

/** A browser profile found on this machine. `id` is its folder; main only reads profiles it found itself. */
export interface ImportProfile { id: string; browser: string; profile: string; engine: 'chromium' | 'firefox'; isDefault?: boolean }

/** What a profile holds (absent: not there). `errors`: a part that could not be read, and why. */
export interface ImportCounts { bookmarks?: number; history?: number; addresses?: number; errors?: string[] }

export interface ImportRequest { profileId: string; parts: ImportPart[] }

export interface ImportSummary {
  browser: string;
  profile: string;
  bookmarks?: { count: number; folder: string; skipped: number };
  history?: { read: number; added: number; updated: number };
  addresses?: { added: number; skipped: number } | { unavailable: string };
  errors: string[];
}

/** What the agent asked the wizard to show (browser_import): the person still confirms. */
export interface ImportPreset { browser?: string; parts?: ImportPart[]; passwords?: boolean; note?: string }

/** A password CSV, read and waiting for the person to confirm the import. No passwords in it. */
export interface PasswordFilePreview { token: string; file: string; source: string; count: number; skipped: number; reasons: Record<string, number>; sites: number }

export interface PasswordImportResult { added: number; updated: number; unchanged: number; file: string }

export interface VaultStatus { available: boolean; reason?: string; count: number }

/** A saved login as the Passwords page lists it: never the password or note. */
export interface VaultItem { id: string; origin: string; username: string; hasNote: boolean; created: number; updated: number; weak?: string; reused?: number }

/** "Save password?" after a sign-in form is submitted. The password stays in main. */
export interface VaultOffer { id: string; tabId: string; origin: string; username: string; update: boolean; unavailable?: string }

/** The logins for the page in front (its exact origin only), for the key button. */
export interface VaultForPage { origin: string; secure: boolean; available: boolean; entries: Array<{ id: string; username: string }> }
