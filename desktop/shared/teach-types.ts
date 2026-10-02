/**
 * Teach AICO — the shapes of a taught browser procedure, shared by main
 * (recording, saving, replay: electron/browser-teach*.ts) and the chrome
 * (the Teach button and the review page: renderer/src/browser/Teach.tsx).
 *
 * WHY A TARGET IS A DESCRIPTION, NOT A SELECTOR. Recorders that save a CSS
 * path or an XPath (the classic record-and-replay failure) break the first
 * time a site moves a button into another <div>. A step remembers what a
 * person would say about the element — its role, its accessible name, its
 * label, the text near it, its form — and replay finds the element that best
 * fits that description now (browser-teach-core.ts `relocate`). CSS and
 * XPath are kept only as weak tie-breakers.
 *
 * WHY THERE IS NO SECRET IN HERE. Passwords, card numbers, CVVs and one-time
 * codes are never read from the page while recording (the recorder does not
 * touch their value) and never stored: such a step is a `secret` action that
 * replays as "sign in with a stored credential by NAME" or "hand over to the
 * person". Typed text that varies is a named parameter (`{{customer_name}}`).
 *
 * @module desktop/shared/teach-types
 */

/** What the page reports about one element (raw facts; roles and names are worked out in main). */
export interface RawTarget {
  tag: string;
  type?: string;
  roleAttr?: string;
  ariaLabel?: string;
  labelledBy?: string;
  labelText?: string;
  placeholder?: string;
  title?: string;
  alt?: string;
  text?: string;
  /** An <input type=submit|button>'s value — its visible label. Never a text field's value. */
  buttonValue?: string;
  id?: string;
  name?: string;
  testId?: string;
  href?: string;
  autocomplete?: string;
  inputmode?: string;
  maxLength?: number;
  /** The nearest fieldset legend / heading / section title before it. */
  nearby?: string;
  /** The form it belongs to: id, name, or the action's path. */
  form?: string;
  css?: string;
  xpath?: string;
  checked?: boolean;
  disabled?: boolean;
  /** Candidates only: the ref replay can act on (data-aico-ref, as browser_snapshot hands out). */
  ref?: string;
  /** Candidates only: on screen and not hidden. */
  visible?: boolean;
}

/** How a step names its element: what a person would say about it. */
export interface TargetDesc {
  role: string;
  name: string;
  tag: string;
  type?: string;
  label?: string;
  text?: string;
  placeholder?: string;
  nearby?: string;
  form?: string;
  attrs?: { id?: string; name?: string; testId?: string; href?: string; autocomplete?: string };
  /** Fallbacks only — weak evidence, never enough on their own. */
  css?: string;
  xpath?: string;
}

export type SecretKind = 'password' | 'card' | 'cvv' | 'otp';

export type ActionKind = 'navigate' | 'click' | 'type' | 'select' | 'press' | 'upload' | 'secret' | 'wait';

export interface ProcedureAction {
  kind: ActionKind;
  target?: TargetDesc;
  /** type / select: the text (may hold {{param}}); upload: {{param}} naming the file path(s). */
  value?: string;
  /** select: the option's visible text when recorded. */
  optionText?: string;
  /** navigate: the address (may hold {{param}}). */
  url?: string;
  /** press: the key. */
  key?: string;
  /** secret: what kind of field, and the parameter that may name a stored credential. */
  secret?: { kind: SecretKind; param?: string };
  /** wait: for text to appear, or a pause. */
  wait?: { text?: string; ms?: number };
  /** What should be true afterwards — checked on replay. */
  expect?: { url?: string; checked?: boolean };
  /** The page's origin when the action was recorded: replay acts only there. */
  origin?: string;
  /** Review only: this typed value is a parameter (its name); unset = typed literally. */
  param?: string;
}

export interface ProcedureStep {
  id: string;
  title: string;
  /** What the step is for, in words — the model's guide when the page changed and the target cannot be found. */
  intent: string;
  actions: ProcedureAction[];
}

export interface ProcedureParam {
  name: string;
  label: string;
  kind: 'text' | 'file' | 'secret';
  /** The value used when a run gives none (the one typed while teaching, unless the person cleared it). Never for secrets. */
  default?: string;
  required: boolean;
}

/** procedure.json inside the skill folder. */
export interface Procedure {
  kind: 'aico.browser-procedure';
  version: 1;
  name: string;
  goal: string;
  origin: string;
  startUrl: string;
  params: ProcedureParam[];
  steps: ProcedureStep[];
  createdAt: string;
}

/** A step under review: the procedure step plus its screenshots (data URLs, kept only until saved). */
export interface DraftStep extends ProcedureStep {
  shots: Array<{ src: string; rect?: { x: number; y: number; w: number; h: number }; vw?: number; vh?: number }>;
}

export interface TeachDraft {
  id: string;
  origin: string;
  startUrl: string;
  title: string;
  steps: DraftStep[];
  /** Notes for the person (a password step was turned into a hand-over, …). */
  notes: string[];
}

export interface TeachState {
  recording: boolean;
  tabId?: string;
  origin?: string;
  steps: number;
  last?: string;
  /** A finished recording is waiting for review. */
  draft?: boolean;
  error?: string;
}

export interface TeachSaveRequest {
  draftId: string;
  name: string;
  goal: string;
  steps: ProcedureStep[];
  overwrite?: boolean;
}

export interface ProcedureSummary {
  name: string;
  goal: string;
  origin: string;
  params: ProcedureParam[];
  steps: number;
}
