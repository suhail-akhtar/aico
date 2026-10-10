/**
 * Clean-room reconstruction: the shared vocabulary (ADR 0041).
 *
 * The pipeline is four stages with one rule between them. **Observe** drives a
 * target through a {@link Sandbox} and records what it did; **synthesize**
 * turns the recording into a {@link Spec}; **implement** builds a clone from
 * the spec alone; **twin-test** runs the same journeys against target and
 * clone and diffs them. The rule is the spec firewall: the implementer never
 * sees the target or the raw observations, only the spec, so the clone is
 * derived from described behaviour rather than from anything the target
 * carries (the clean-room method).
 *
 * One interface, {@link Sandbox}, hides what the target is. A web page, a
 * command line and (later) a window, a phone or a daemon all answer the same
 * four verbs: start, inject a stimulus, observe, stop. That is what lets the
 * explorer, the state-graph builder and the twin-test harness be written once.
 *
 * Deliberately not here: any gate on what may be observed. This is neutral
 * execution infrastructure, like a debugger or a packet capture; who may point
 * it at what is the operator's responsibility (ADR 0041).
 *
 * @module cleanroom/types
 */

export type TargetKind = 'web' | 'cli' | 'api' | 'library' | 'daemon' | 'desktop' | 'mobile';

/** What to start. Exactly one of the shapes, chosen by `kind`. */
export type LaunchSpec =
  | { kind: 'web'; url: string; viewport?: { width: number; height: number }; locale?: string; timeoutMs?: number }
  | { kind: 'cli'; command: string; args?: string[]; cwd?: string; env?: Record<string, string>; columns?: number; rows?: number; timeoutMs?: number; interactive?: boolean; /** Run under a pseudo-terminal: a program that checks isatty or draws a TUI behaves like itself. */ pty?: boolean; /** The program's name in the spec; defaults to the executable's. */ name?: string }
  | { kind: 'api'; baseUrl: string; headers?: Record<string, string>; timeoutMs?: number }
  /** A module to load and probe: a file or a package folder. Node (.js .mjs .cjs) or Python (.py or a package). */
  /** An Android app on a device or emulator, driven through adb (uiautomator for the tree, input for touch). iOS is not built. */
  | { kind: 'mobile'; platform?: 'android' | 'ios'; appId: string; serial?: string; adb?: string; activity?: string; timeoutMs?: number; name?: string }
  /** A native desktop application, driven through the operating system's accessibility tree (Windows UI Automation). */
  | { kind: 'desktop'; command: string; args?: string[]; cwd?: string; env?: Record<string, string>; windowTitle?: string; timeoutMs?: number; name?: string }
  /** A long-running background process: started, waited for until it is ready, then driven over its channels, signals and watched folders. */
  | {
    kind: 'daemon'; command: string; args?: string[]; cwd?: string; env?: Record<string, string>; name?: string; timeoutMs?: number;
    /** Ready when this appears in its output (a capture group names the TCP port), or when this port or socket accepts a connection. */
    ready?: { logMatch?: string; port?: number; socket?: string; timeoutMs?: number };
    /** Extra channels to probe: Unix-domain socket paths or Windows named pipes (\\.\pipe\name), and TCP host:port pairs. */
    ipc?: string[];
    /** Folders the daemon is expected to watch: a file is written into one to see what it does. */
    watchDirs?: string[];
  }
  | { kind: 'library'; entry: string; language?: 'node' | 'python'; cwd?: string; timeoutMs?: number; name?: string };

/** One thing done to the target. Serialisable, so a journey can be replayed on the clone. */
export type Stimulus =
  | { type: 'navigate'; url: string }
  | { type: 'click'; selector: string }
  | { type: 'fill'; selector: string; value: string }
  | { type: 'press'; key: string }
  | { type: 'scroll'; dy: number }
  | { type: 'wait'; ms: number }
  | { type: 'run'; args: string[]; stdin?: string; env?: Record<string, string> } // CLI one-shot
  | { type: 'stdin'; data: string }                                              // CLI interactive
  | { type: 'signal'; signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP' }
  | { type: 'resize'; columns: number; rows: number }                            // CLI under a pty
  | { type: 'request'; method: string; path: string; headers?: Record<string, string>; body?: unknown }
  /** Library: call (or `construct`) an export, or a method of an object an earlier call returned (`on` is its handle). */
  | { type: 'call'; fn: string; args?: unknown[]; on?: string; construct?: boolean }
  | { type: 'get'; prop: string; on?: string }
  /** Daemon: write bytes to a channel ('tcp' = the ready port, 'tcp:host:port', 'socket:path' or 'pipe:\\.\pipe\name') and read what comes back. */
  /** Mobile gestures and system events. */
  | { type: 'swipe'; x1: number; y1: number; x2: number; y2: number; ms?: number }
  | { type: 'rotate'; orientation: 'portrait' | 'landscape' }
  | { type: 'background' }
  | { type: 'resume' }
  | { type: 'deeplink'; url: string }
  | { type: 'permission'; action: 'grant' | 'revoke'; permission: string }
  | { type: 'notify'; title: string; text: string }
  | { type: 'send'; channel: string; data: string; waitMs?: number }
  /** Daemon: create, change or remove a file inside a watched folder. */
  | { type: 'fs-write'; path: string; content: string }
  | { type: 'fs-delete'; path: string };

/** What a daemon did after a stimulus. */
export interface DaemonResult {
  alive: boolean; exitCode?: number | null; signal?: string | null;
  /** The reply on the channel (utf8, capped), and whether the other side closed the connection. */
  reply?: string; closed?: boolean; connectError?: string;
  /** Output the daemon wrote since the last observation. */
  newStdout?: string; newStderr?: string;
  /** Files that appeared, changed or went away in the watched folders. */
  fsChanges?: { path: string; kind: 'added' | 'changed' | 'removed' }[];
  signalDelivery?: 'signal' | 'forced';
  /** The TCP port found from its output, when it printed one. */
  port?: number;
}

/** What a call into a library produced: a value (with its kind) or an error, and what it wrote to the console. */
export interface CallResult { ok: boolean; async?: boolean; kind?: string; value?: unknown; error?: { name: string; message: string; code?: string }; output?: string; ms?: number }

/** One export as the worker lists it, before anything is called. */
export interface LibExportInfo {
  name: string; kind: 'function' | 'object' | 'value'; arity?: number;
  params?: { name: string; kind: string; hasDefault: boolean; annotation: string | null }[] | null;
  isClass?: boolean; isCoroutine?: boolean;
  members?: { name: string; kind: string; arity?: number; params?: LibExportInfo['params'] }[];
  statics?: { name: string; arity: number }[];
  fns?: { name: string; arity: number }[];
  value?: unknown;
}

export interface NetworkEvent { method: string; url: string; status?: number; requestBody?: string; responseBody?: string; contentType?: string }

/** What the target looked like after a stimulus. Fields are filled by the adapters that can. */
export interface Observation {
  at: string;
  kind: TargetKind;
  // web
  url?: string;
  title?: string;
  /** Accessibility/role tree as text (Playwright aria snapshot): the structure a person perceives. */
  tree?: string;
  /** Visible text, whitespace-collapsed. */
  text?: string;
  /** Interactive elements found on the page, with a selector that re-finds them. */
  controls?: Control[];
  network?: NetworkEvent[];
  /** Measured look of the page: values read from computed styles, not the target's stylesheet. */
  style?: StyleFacts;
  /** PNG of the viewport; kept in the corpus, never copied into the spec. */
  frame?: Uint8Array;
  // cli
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  signal?: string | null;
  /** Rendered terminal screen (rows of text) after replaying the ANSI stream. */
  screen?: string[];
  durationMs?: number;
  // daemon
  daemon?: DaemonResult;
  // library
  call?: CallResult;
  /** The exports the worker listed (recorded once, as the first step of a library journey). */
  surface?: LibExportInfo[];
  /** How the last signal reached the program: a real signal, a Ctrl-C keystroke on a pty, or forced termination (Windows has no SIGTERM/SIGHUP). */
  signalDelivery?: 'signal' | 'ctrl-c' | 'forced';
  /** Whether the program ran under a pseudo-terminal, and the host platform it ran on. */
  terminal?: { tty: boolean; platform: string };
  // api
  response?: { status: number; headers: Record<string, string>; body: string; contentType?: string };
  error?: string;
}

export interface StyleFacts {
  colors: { background: string[]; text: string[]; accent: string[] };
  fonts: string[]; fontSizes: number[]; radii: number[]; spacing: number[];
  /** Landmarks and large blocks with their boxes (px, relative to the viewport at the time). */
  layout: { role: string; x: number; y: number; w: number; h: number }[];
  viewport: { width: number; height: number };
}

export interface Control { role: string; name: string; selector: string; href?: string; inputType?: string; formAction?: string }

/** A cheap identity for "the same state again": equal fingerprints are one node of the graph. */
export type StateFingerprint = string;

export interface Sandbox {
  readonly kind: TargetKind;
  start(spec: LaunchSpec, signal?: AbortSignal): Promise<void>;
  inject(stimulus: Stimulus): Promise<void>;
  observe(): Promise<Observation>;
  snapshot(): Promise<StateFingerprint>;
  stop(): Promise<void>;
}

/** One recorded step: where it started, what was done, what came out. */
export interface Step { seq: number; from: StateFingerprint; stimulus: Stimulus; observation: Observation; to: StateFingerprint }

export interface Journey { id: string; target: LaunchSpec; steps: Step[]; /** The host platform the recording was made on. */ platform?: string }

// ── The spec: the only thing that crosses the firewall ─────────────────────────

export interface SpecState { id: StateFingerprint; label: string; summary: string; controls?: string[] }
export interface SpecTransition { from: StateFingerprint; to: StateFingerprint; event: string; sideEffects: string[]; count: number }

export interface WebSpec {
  states: SpecState[]; transitions: SpecTransition[];
  routes: { path: string; title: string; states: StateFingerprint[] }[];
  /** Layout/colour facts measured from the page, as values, not as the target's CSS. */
  tokens?: { colors: { background: string[]; text: string[]; accent: string[] }; fonts: string[]; fontSizes: number[]; radii: number[]; spacing: number[] };
  /** The landing page's layout outline, for matching proportions. */
  layout?: { role: string; x: number; y: number; w: number; h: number }[];
  viewport?: { width: number; height: number };
}
export interface CliSpec {
  name: string;
  commands: { path: string[]; usage: string; summary: string; flags: { name: string; takesValue: boolean; description: string }[] }[];
  cases: { args: string[]; stdin?: string; stdout: string; stderr: string; exitCode: number | null }[];
}
export interface ApiSpec {
  baseUrl: string;
  operations: { method: string; path: string; requestSchema?: JsonSchema; responses: { status: number; contentType?: string; schema?: JsonSchema; example?: unknown }[] }[];
}

export interface Spec {
  version: 1;
  id: string;
  kind: TargetKind;
  createdAt: string;
  coverage: { steps: number; states: number; transitions: number; note: string; /** Of everything the explorer found, how much it tried (0 to 1); absent when the exploration state was not kept. */ ratio?: number; discovered?: number; tried?: number; /** Found but not tried: the frontier a further run would cover. */ pending?: string[]; skipped?: { item: string; reason: string }[]; stoppedBy?: 'complete' | 'budget' | 'aborted' };
  web?: WebSpec; /* also holds a desktop application: windows are its routes */ cli?: CliSpec; api?: ApiSpec; library?: LibrarySpec; daemon?: DaemonSpec;
  /** Behaviour the observer could not pin down: said out loud so the clone is not trusted blindly. */
  unknowns: string[];
}

export interface LibParam { name: string; type: string; optional: boolean }
export interface LibMember { name: string; kind: 'method' | 'accessor' | 'static'; params: LibParam[]; returns: string; async: boolean; throws: { name: string; message: string }[] }
export interface LibExport {
  name: string; kind: 'function' | 'class' | 'object' | 'value';
  params: LibParam[]; returns: string; async: boolean;
  throws: { name: string; message: string }[];
  examples: { args: string; result: string }[];
  members?: LibMember[]; value?: string;
}
/** What the black-box probing learned about a library's public surface. `dts` is the synthesized declaration file. */
export interface LibrarySpec { language: 'node' | 'python'; name: string; exports: LibExport[]; declarations: string }

/** What probing a daemon learned: how it starts, what it says on each channel, how it handles signals and watched files. */
export interface DaemonSpec {
  name: string;
  startup: { readyBy: string; output: string };
  channels: { channel: string; exchanges: { send: string; reply: string; closed: boolean }[] }[];
  signals: { signal: string; exited: boolean; exitCode: number | null; output: string; delivery: 'signal' | 'forced' }[];
  files: { action: string; reaction: string }[];
}

export type JsonSchema = { type?: string | string[]; properties?: Record<string, JsonSchema>; items?: JsonSchema; required?: string[]; enum?: unknown[]; format?: string; nullable?: boolean };

// ── Twin-testing ───────────────────────────────────────────────────────────────

export interface Difference { step: number; stimulus: Stimulus; field: string; target: unknown; clone: unknown }
export interface TwinReport { journeys: number; steps: number; identical: number; differences: Difference[]; parity: number /* identical/steps */ ; notes: string[]; /** How much of what the explorer found it tried, so parity is read next to it. */ coverage?: string }
