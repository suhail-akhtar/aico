/**
 * The evidence that a person prefers to work a certain way, captured as it
 * happens and kept only as short, redacted excerpts.
 *
 * Four kinds, each the person's own act rather than the agent's guess:
 *
 *  - **feedback** — a 👍/👎 with a note (a rating without words says too
 *    little to generalise from, so it is not a signal);
 *  - **correction** — a sentence in their message that corrects or sets a
 *    standing rule: "no, use X", "always…", "never…", "from now on…";
 *  - **edit** — a change they made by hand to a file or canvas the agent had
 *    just written, kept as a diff *summary* (counts, the style change it
 *    shows, up to three short line pairs), never the file;
 *  - **choice** — the same option picked again and again (pnpm three times,
 *    tabs three times, "tests first" three times), tallied across sessions.
 *
 * Signals are not rules. They wait in a small pending file until the
 * distiller (`distill.ts`) turns them into *proposed* rules a person accepts.
 * Every excerpt passes the vault's sink redactor and the high-confidence
 * secret scanner before it is written, because this file is read back into a
 * model call.
 *
 * Deliberately not here: tone or sentiment analysis, anything inferred about
 * the person rather than the work, and full file contents on disk — the
 * before-image of an agent-written file lives in memory only, for thirty
 * minutes, so "shortly after" is literal.
 *
 * @module learning/signals
 */

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import type { Session } from '../session/session.js';
import type { SessionEvent } from '../session/events.js';
import { aicoHome } from '../home.js';
import { redact } from '../vault/index.js';
import { scanForSecrets } from '../vault/scan.js';

export type SignalKind = 'feedback' | 'correction' | 'edit' | 'choice';

export interface PreferenceSignal {
  /** Stable: the same act captured twice is one signal. */
  id: string;
  kind: SignalKind;
  /** What the person said or did, redacted, at most {@link MAX_SIGNAL_CHARS}. */
  text: string;
  sessionId: string;
  /** The event that carries it, when there is one — the evidence link. */
  seq?: number;
  /** The project it happened in. */
  projectRoot?: string;
  /** For edits and choices that are about one language. */
  language?: string;
  at: number;
}

export const MAX_SIGNAL_CHARS = 600;
/** Pending signals kept before the oldest are dropped unread. */
export const MAX_PENDING = 200;
/** How long after the agent wrote a file a hand edit still counts as a reaction to it. */
export const EDIT_WINDOW_MS = 30 * 60_000;
/** How often a choice must repeat, and how dominant it must be, to be a signal. */
export const CHOICE_MIN_COUNT = 3;
export const CHOICE_MIN_SHARE = 0.75;

// ── Scrubbing ───────────────────────────────────────────────────────────────

/**
 * Redact for a model call: the vault's own values first (exact), then any
 * high-confidence secret shape the scanner knows, then the user's home path
 * (a name is personal data and never a work preference).
 */
export function scrub(text: string): string {
  let out = redact.text(text);
  const found = scanForSecrets(out);
  for (const s of [...found].reverse()) out = `${out.slice(0, s.start)}[secret]${out.slice(s.end)}`;
  return out
    .replace(/[A-Za-z]:\\Users\\[^\\\s"'`]+/g, '~')
    .replace(/\/(?:home|Users)\/[^/\s"'`]+/g, '~')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]');
}

function clip(text: string, max = MAX_SIGNAL_CHARS): string {
  const t = text.replace(/\s+\n/g, '\n').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function signalId(kind: SignalKind, key: string): string {
  return `sig-${kind}-${createHash('sha1').update(key).digest('hex').slice(0, 12)}`;
}

export function makeSignal(input: Omit<PreferenceSignal, 'id' | 'text'> & { text: string; key?: string }): PreferenceSignal {
  const { key, ...rest } = input;
  const text = clip(scrub(rest.text));
  return { ...rest, text, id: signalId(rest.kind, key ?? `${rest.sessionId}:${rest.seq ?? ''}:${text}`) };
}

// ── Pure detectors ──────────────────────────────────────────────────────────

/**
 * Sentences that correct the agent or set a standing rule.
 *
 * High precision over recall: a question is never a correction, and a plain
 * request ("add a button") is not one either. What the patterns miss, a 👎
 * with a note or the person's own rule in the Settings page still captures.
 */
const CORRECTION = [
  /^\s*(?:no|nope|wrong|not that|stop)\b[\s,.!:;-]/i,
  /\b(?:always|never|from now on|going forward|in future|by default|every time)\b/i,
  /\b(?:i|we) (?:prefer|like|want|use|always|never)\b/i,
  /\b(?:don'?t|do not|please don'?t|stop) (?:use|using|add|adding|write|writing|run|running|put|make)\b/i,
  /\buse\s+[\w.@/-]+(?:\s*,)?\s+(?:not|instead of|rather than)\s+[\w.@/-]+/i,
  /\binstead of\b/i,
];

export function detectCorrections(text: string): string[] {
  const sentences = text
    .replace(/```[\s\S]*?```/g, ' ')
    .split(/(?<=[.!?])\s+|\n+/)
    .map(s => s.trim())
    // Three words at least: "Always." on its own is emphasis, not a rule.
    .filter(s => s.length >= 6 && s.length <= 300 && !s.endsWith('?') && s.split(/\s+/).length >= 3);
  return sentences.filter(s => CORRECTION.some(re => re.test(s))).slice(0, 3);
}

export interface Choice { dimension: 'package-manager' | 'indentation' | 'test-order'; value: string }

/** The options a message picks, by dimension. Pure; the tally is kept elsewhere. */
export function detectChoices(text: string): Choice[] {
  const out: Choice[] = [];
  const pm = /\b(pnpm|yarn|bun|npm)\s+(?:install|add|i|run|dlx|exec|test|ci|create)\b|\buse\s+(pnpm|yarn|bun|npm)\b|\bwith\s+(pnpm|yarn|bun|npm)\b/i.exec(text);
  if (pm) out.push({ dimension: 'package-manager', value: (pm[1] ?? pm[2] ?? pm[3]!).toLowerCase() });
  const indent = /\b(tabs|tab indentation|indent with tabs)\b|\b([24])[- ]space(?:s)?(?: indent(?:ation)?)?\b|\bspaces(?: not tabs)?\b/i.exec(text);
  if (indent) out.push({ dimension: 'indentation', value: indent[1] ? 'tabs' : indent[2] ? `${indent[2]} spaces` : 'spaces' });
  if (/\b(?:tests? first|tdd|test[- ]driven|write (?:the )?tests? (?:before|first))\b/i.test(text)) out.push({ dimension: 'test-order', value: 'tests-first' });
  return out;
}

/** What a language is called in a rule scope, from a file's extension. */
export function languageOf(file: string): string | undefined {
  const ext = path.extname(file).toLowerCase();
  return ({
    '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
    '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
    '.py': 'python', '.go': 'go', '.rs': 'rust', '.java': 'java', '.kt': 'kotlin', '.cs': 'csharp',
    '.rb': 'ruby', '.php': 'php', '.swift': 'swift', '.css': 'css', '.scss': 'css', '.md': 'markdown',
    '.html': 'html', '.sql': 'sql', '.sh': 'shell', '.ps1': 'powershell',
  } as Record<string, string>)[ext];
}

function indentStyle(lines: string[]): 'tabs' | 'spaces' | undefined {
  let tabs = 0;
  let spaces = 0;
  for (const l of lines) {
    if (l.startsWith('\t')) tabs++;
    else if (/^ {2,}\S/.test(l)) spaces++;
  }
  if (tabs + spaces < 3) return undefined;
  return tabs > spaces * 3 ? 'tabs' : spaces > tabs * 3 ? 'spaces' : undefined;
}

/**
 * What a hand edit changed, in a few lines a model can read: counts, any
 * whole-file style shift it shows, and up to three removed/added pairs.
 *
 * A multiset line diff, not an LCS: order-insensitive, linear, and enough to
 * say "you replaced these lines with those", which is all a summary needs.
 * Returns undefined when nothing but trailing whitespace changed.
 */
export function summariseEdit(label: string, before: string, after: string): string | undefined {
  if (before === after) return undefined;
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  const count = new Map<string, number>();
  for (const l of a) count.set(l.trimEnd(), (count.get(l.trimEnd()) ?? 0) + 1);
  const added: string[] = [];
  for (const l of b) {
    const k = l.trimEnd();
    const n = count.get(k) ?? 0;
    if (n > 0) count.set(k, n - 1);
    else added.push(l);
  }
  const removed: string[] = [];
  for (const l of a) {
    const k = l.trimEnd();
    const n = count.get(k) ?? 0;
    if (n > 0) { removed.push(l); count.set(k, n - 1); }
  }
  if (added.length === 0 && removed.length === 0) return undefined;
  const notes: string[] = [];
  const was = indentStyle(a);
  const now = indentStyle(b);
  if (was && now && was !== now) notes.push(`re-indented with ${now} (was ${was})`);
  const quote = (ls: string[], q: string) => ls.join('\n').split(q).length - 1;
  if (quote(removed, "'") > 3 && quote(added, '"') > 3 && quote(added, "'") === 0) notes.push('switched single quotes to double');
  if (quote(removed, '"') > 3 && quote(added, "'") > 3 && quote(added, '"') === 0) notes.push('switched double quotes to single');
  const semis = (ls: string[]) => ls.filter(l => /;\s*$/.test(l)).length;
  if (semis(removed) >= 3 && semis(added) === 0 && added.length >= 3) notes.push('removed trailing semicolons');
  const pairs: string[] = [];
  const meaningful = (l: string) => l.trim().length > 0;
  const rm = removed.filter(meaningful);
  const ad = added.filter(meaningful);
  for (let i = 0; i < Math.min(3, Math.max(rm.length, ad.length)); i++) {
    if (rm[i] !== undefined) pairs.push(`- ${rm[i]!.trim().slice(0, 120)}`);
    if (ad[i] !== undefined) pairs.push(`+ ${ad[i]!.trim().slice(0, 120)}`);
  }
  return [`${label}: +${added.length} −${removed.length} lines${notes.length ? `; ${notes.join('; ')}` : ''}`, ...pairs].join('\n');
}

// ── Reading a turn from the log ─────────────────────────────────────────────

function turnEvents(events: readonly SessionEvent[], turn: number): SessionEvent[] {
  return events.filter(e => (e.data as { turn?: number } | undefined)?.turn === turn);
}

/** Corrections in every human message of the turn, and the choices they make. */
export function signalsFromTurn(session: Session, turn: number, projectRoot: string, now = Date.now()): { signals: PreferenceSignal[]; choices: Array<Choice & { seq: number }> } {
  const signals: PreferenceSignal[] = [];
  const choices: Array<Choice & { seq: number }> = [];
  for (const e of turnEvents(session.events, turn)) {
    if (e.type !== 'user/message') continue;
    const d = e.data as { content: string; source: { kind: string } };
    // Only a person's words: a plugin nudge or a gate's message is not a preference.
    if (d.source.kind !== 'human') continue;
    for (const sentence of detectCorrections(d.content)) {
      signals.push(makeSignal({ kind: 'correction', text: sentence, sessionId: session.header.id, seq: e.seq, projectRoot, at: now }));
    }
    for (const c of detectChoices(d.content)) choices.push({ ...c, seq: e.seq });
  }
  return { signals, choices };
}

/** A 👍/👎 with a note, with the start of the message it rated for context. */
export function feedbackSignal(session: Session, targetSeq: number, rating: 'up' | 'down', note: string, projectRoot: string, now = Date.now()): PreferenceSignal | undefined {
  if (!note.trim()) return undefined;
  const target = session.events.find(e => e.seq === targetSeq);
  const rated = target?.type === 'assistant/message' ? String((target.data as { content?: string }).content ?? '').replace(/\s+/g, ' ').slice(0, 200) : '';
  const latest = [...session.events].reverse().find(e => e.type === 'message/feedback' && (e.data as { targetSeq: number }).targetSeq === targetSeq);
  return makeSignal({
    kind: 'feedback',
    text: `${rating === 'up' ? '👍' : '👎'} "${note.trim()}"${rated ? ` — on a reply that began: ${rated}` : ''}`,
    sessionId: session.header.id,
    ...(latest ? { seq: latest.seq } : { seq: targetSeq }),
    projectRoot,
    at: now,
    key: `${session.header.id}:${targetSeq}:${rating}:${note.trim()}`,
  });
}

// ── Hand edits after an agent write ─────────────────────────────────────────

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const MAX_SNAPSHOT_FILES = 6;
const MAX_SNAPSHOT_BYTES = 120_000;

interface Snapshot { at: number; cwd: string; files: Map<string, string> }
const snapshots = new Map<string, Snapshot>();

/** The files the agent wrote this turn, as they stand now: the before-image of any hand edit. In memory only. */
export function rememberAgentWrites(session: Session, turn: number, cwd: string, now = Date.now()): number {
  const paths = new Set<string>();
  for (const e of turnEvents(session.events, turn)) {
    if (e.type !== 'tool/call') continue;
    const d = e.data as { name: string; arguments: string };
    if (!WRITE_TOOLS.has(d.name)) continue;
    try {
      const args = JSON.parse(d.arguments) as { file_path?: string; path?: string; notebook_path?: string };
      const p = args.file_path ?? args.path ?? args.notebook_path;
      if (p) paths.add(path.resolve(cwd, p));
    } catch { /* malformed arguments: nothing to remember */ }
  }
  const files = new Map<string, string>();
  for (const p of [...paths].slice(-MAX_SNAPSHOT_FILES)) {
    try {
      if (fs.statSync(p).size > MAX_SNAPSHOT_BYTES) continue;
      files.set(p, fs.readFileSync(p, 'utf8'));
    } catch { /* deleted or unreadable: there is nothing to compare against */ }
  }
  if (files.size) snapshots.set(session.header.id, { at: now, cwd, files });
  return files.size;
}

/** Hand edits since the agent's last writes in this session, as edit signals. Consumes the snapshot. */
export function userEditSignals(sessionId: string, now = Date.now()): PreferenceSignal[] {
  const snap = snapshots.get(sessionId);
  if (!snap) return [];
  snapshots.delete(sessionId);
  if (now - snap.at > EDIT_WINDOW_MS) return [];
  const out: PreferenceSignal[] = [];
  for (const [file, before] of snap.files) {
    let after: string;
    try { after = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const rel = path.relative(snap.cwd, file).replace(/\\/g, '/');
    const summary = summariseEdit(rel.startsWith('..') ? path.basename(file) : rel, before, after);
    if (!summary) continue;
    const language = languageOf(file);
    out.push(makeSignal({
      kind: 'edit', text: `You edited a file the agent had just written — ${summary}`,
      sessionId, projectRoot: snap.cwd, ...(language ? { language } : {}), at: now,
      key: `${sessionId}:${file}:${createHash('sha1').update(after).digest('hex')}`,
    }));
  }
  return out;
}

/** A canvas tab the person changed after the agent wrote it: the same kind of signal. */
export function canvasEditSignal(input: {
  sessionId: string; projectRoot?: string; title: string; language?: string;
  agentVersion: { content: string; at: number }; userVersion: { content: string; at: number; version: number };
}): PreferenceSignal | undefined {
  if (input.userVersion.at - input.agentVersion.at > EDIT_WINDOW_MS) return undefined;
  const summary = summariseEdit(`canvas "${input.title}"`, input.agentVersion.content, input.userVersion.content);
  if (!summary) return undefined;
  return makeSignal({
    kind: 'edit', text: `You edited a canvas the agent had just written — ${summary}`,
    sessionId: input.sessionId, ...(input.projectRoot ? { projectRoot: input.projectRoot } : {}),
    ...(input.language ? { language: input.language } : {}), at: input.userVersion.at,
    key: `${input.sessionId}:canvas:${input.title}:${input.userVersion.version}`,
  });
}

// ── Pending store and the choice tally ──────────────────────────────────────

function learningDir(): string {
  return path.join(aicoHome(), 'learning', 'preferences');
}
export function signalsFile(): string { return path.join(learningDir(), 'signals.jsonl'); }
function choicesFile(): string { return path.join(learningDir(), 'choices.json'); }

export function readPendingSignals(): PreferenceSignal[] {
  try {
    return fs.readFileSync(signalsFile(), 'utf8').split('\n').filter(Boolean).flatMap(l => {
      try { return [JSON.parse(l) as PreferenceSignal]; } catch { return []; }
    });
  } catch {
    return [];
  }
}

function writePending(all: PreferenceSignal[]): void {
  fs.mkdirSync(learningDir(), { recursive: true });
  const kept = all.slice(-MAX_PENDING);
  fs.writeFileSync(signalsFile(), kept.map(s => JSON.stringify(s)).join('\n') + (kept.length ? '\n' : ''), 'utf8');
}

/** Queue signals for the distiller, skipping any already queued. Returns how many were new. */
export function queueSignals(incoming: PreferenceSignal[]): number {
  if (incoming.length === 0) return 0;
  const all = readPendingSignals();
  const seen = new Set(all.map(s => s.id));
  const fresh = incoming.filter(s => s.text && !seen.has(s.id) && (seen.add(s.id), true));
  if (fresh.length) writePending([...all, ...fresh]);
  return fresh.length;
}

/** Drop signals the distiller has read. */
export function consumeSignals(ids: readonly string[]): void {
  const gone = new Set(ids);
  const all = readPendingSignals();
  const left = all.filter(s => !gone.has(s.id));
  if (left.length !== all.length) writePending(left);
}

type Tally = Record<string, { counts: Record<string, { n: number; sessions: string[] }>; emitted?: string }>;

/**
 * Count choices; return a signal for any that has now become a habit — seen
 * {@link CHOICE_MIN_COUNT} times, in at least two sessions, at
 * {@link CHOICE_MIN_SHARE} of that dimension's picks — once per value.
 */
export function tallyChoices(choices: ReadonlyArray<Choice & { seq: number }>, sessionId: string, projectRoot: string, now = Date.now()): PreferenceSignal[] {
  if (choices.length === 0) return [];
  let tally: Tally = {};
  try { tally = JSON.parse(fs.readFileSync(choicesFile(), 'utf8')) as Tally; } catch { /* first choice ever */ }
  const out: PreferenceSignal[] = [];
  for (const c of choices) {
    const dim = (tally[c.dimension] ??= { counts: {} });
    const entry = (dim.counts[c.value] ??= { n: 0, sessions: [] });
    entry.n++;
    if (!entry.sessions.includes(sessionId)) entry.sessions = [...entry.sessions, sessionId].slice(-10);
    const total = Object.values(dim.counts).reduce((s, v) => s + v.n, 0);
    if (dim.emitted !== c.value && entry.n >= CHOICE_MIN_COUNT && entry.sessions.length >= 2 && entry.n / total >= CHOICE_MIN_SHARE) {
      dim.emitted = c.value;
      out.push(makeSignal({
        kind: 'choice', text: `Chose ${c.dimension.replace('-', ' ')} "${c.value}" ${entry.n} times across ${entry.sessions.length} sessions (${Math.round(100 * entry.n / total)}% of picks).`,
        sessionId, seq: c.seq, projectRoot, at: now, key: `choice:${c.dimension}:${c.value}`,
      }));
    }
  }
  fs.mkdirSync(learningDir(), { recursive: true });
  fs.writeFileSync(choicesFile(), JSON.stringify(tally, null, 2), 'utf8');
  return out;
}
