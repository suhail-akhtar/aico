/**
 * Session display names.
 *
 * A session is created before anyone knows what it is about, so its name has to
 * arrive in stages:
 *
 *   1. **Fallback**, the instant the first message lands — the leading words of
 *      what was asked. Deterministic, free, and immediately useful.
 *   2. **Model**, once the first turn finishes — a short label written by the
 *      model from the actual exchange, which knows the difference between
 *      "Fix the flaky test in the auth suite" and the first eight words of a
 *      pasted stack trace.
 *   3. **User**, whenever someone renames it — which *pins* the name. Automatic
 *      generation stops for good; nothing is more authoritative than a person
 *      saying what their own session is called.
 *
 * ## Titles are untrusted text
 *
 * Both automatic sources are attacker-reachable. The fallback is whatever was
 * typed or pasted — and pasted content routinely contains terminal escapes. The
 * model title is worse: model output can be steered by anything in the context,
 * including a file the agent was asked to read.
 *
 * That text is then rendered in a terminal session list and an HTML sidebar. So
 * it is sanitized rather than trusted:
 *
 *   - **ANSI escapes** (OSC, CSI, two-byte ESC) are stripped. An OSC sequence in
 *     a session list can retitle the user's terminal window; a CSI sequence can
 *     repaint or hide the lines around it.
 *   - **Directional overrides** (RLO and friends) are stripped. They reorder
 *     displayed text without changing its bytes, which is exactly how a title
 *     is made to read as something other than what it says.
 *   - **Control characters** are stripped and whitespace is collapsed, so a
 *     title is always one line.
 *
 * Truncation is by UTF-8 *bytes* but never splits a code point: a byte budget
 * is what storage and terminals actually care about, and cutting mid-sequence
 * produces a replacement character in every renderer downstream.
 *
 * @module session/title
 */

import type { Session } from './session.js';

/**
 * Control-sequence patterns, built with `new RegExp` from escaped strings
 * rather than written as regex literals.
 *
 * A literal would put real ESC and zero-width bytes into this source file,
 * where every editor, diff viewer, patch tool and code-review UI between here
 * and production is entitled to normalize them away — silently turning the
 * sanitizer into a no-op. Escapes survive that trip; raw control bytes do not.
 */

/** Operating-system-command escapes, including an unterminated tail. */
const OSC_SEQUENCE = new RegExp(
  '(?:\\u001B\\]|\\u009D)(?:(?!\\u0007|\\u001B\\\\)[\\s\\S])*(?:\\u0007|\\u001B\\\\|$)', 'gu');
/** Control-sequence-introducer escapes, such as SGR colour codes. */
const CSI_SEQUENCE = new RegExp('(?:\\u001B\\[|\\u009B)[0-?]*[ -/]*[@-~]', 'gu');
/** Remaining two-byte ESC controls. */
const ESC_SEQUENCE = new RegExp('\\u001B[@-_]', 'gu');
/** Non-whitespace C0/C1 controls. */
const CONTROL_CHARACTER = new RegExp(
  '[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F]', 'gu');
/** Directional and invisible controls that make a displayed title deceptive. */
const DIRECTIONAL_CONTROL = new RegExp(
  '[\\u200B\\u200E\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u206F\\uFEFF]', 'gu');

/** Straight and curly quotes a model may wrap a title in. */
const WRAPPING_QUOTES = new RegExp(
  '^["\'\\u201C\\u201D\\u2018\\u2019`]+|["\'\\u201C\\u201D\\u2018\\u2019`]+$', 'g');
/** Longest a stored title may be, in UTF-8 bytes. */
export const TITLE_MAX_BYTES = 120;
/** Words kept when deriving a title from the first message. */
export const FALLBACK_MAX_WORDS = 8;

/** Strip controls and collapse to a single trimmed line. */
function cleanTitleText(input: string): string {
  return input
    .replace(OSC_SEQUENCE, '')
    .replace(CSI_SEQUENCE, '')
    .replace(ESC_SEQUENCE, '')
    .replace(CONTROL_CHARACTER, '')
    .replace(DIRECTIONAL_CONTROL, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * Truncate to a UTF-8 byte budget without splitting a code point.
 *
 * Iterating the string yields whole code points, so a multi-byte character is
 * either wholly included or wholly dropped.
 */
export function truncateTitleUtf8(input: string, maxBytes: number): string {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('maxBytes must be a positive integer');
  }
  if (Buffer.byteLength(input, 'utf8') <= maxBytes) return input;
  let used = 0;
  let output = '';
  for (const character of input) {
    const bytes = Buffer.byteLength(character, 'utf8');
    if (used + bytes > maxBytes) break;
    output += character;
    used += bytes;
  }
  return output;
}

/** Sanitize one title and enforce its byte budget. May return empty. */
export function normalizeSessionTitle(input: string, maxBytes = TITLE_MAX_BYTES): string {
  return truncateTitleUtf8(cleanTitleText(input), maxBytes).trimEnd();
}

/**
 * The deterministic first-prompt title.
 *
 * Leading words rather than a truncated character run, because cutting
 * mid-word reads as corruption where cutting between words reads as a summary.
 */
export function fallbackSessionTitle(
  input: string,
  maxWords = FALLBACK_MAX_WORDS,
  maxBytes = TITLE_MAX_BYTES,
): string {
  const cleaned = cleanTitleText(input);
  if (!cleaned) return '';
  const words = cleaned.split(' ').slice(0, maxWords).join(' ');
  const truncated = truncateTitleUtf8(words, maxBytes).trimEnd();
  // Mark elision only when something was actually dropped.
  const droppedWords = cleaned.split(' ').length > maxWords;
  const droppedBytes = truncated.length < words.length;
  return droppedWords || droppedBytes ? `${truncated}…` : truncated;
}

/** The prompt that asks a model to name a session. */
export const TITLE_PROMPT = [
  'Write a short title for this conversation, for a sidebar list.',
  '',
  'Rules:',
  '- Between three and seven words.',
  '- Name the concrete subject, not the interaction. "Fix flaky auth test",',
  '  not "User asks for help".',
  '- No quotes, no trailing punctuation, no markdown, no emoji.',
  '- Reply with the title alone and nothing else.',
].join('\n');

/**
 * Build the one-shot request that names a session.
 *
 * Only the first exchange is sent, and the assistant side is clipped hard. A
 * title needs the topic, and sending an entire turn — with its tool output — to
 * a summarizer costs more than the turn it is naming.
 */
export function buildTitleRequest(firstUserMessage: string, firstAssistantReply: string): string {
  const ask = firstUserMessage.slice(0, 2000);
  const reply = firstAssistantReply.slice(0, 500);
  return [
    TITLE_PROMPT,
    '',
    '<conversation>',
    `<user>${ask}</user>`,
    ...(reply ? [`<assistant>${reply}</assistant>`] : []),
    '</conversation>',
  ].join('\n');
}

/**
 * Clean up what the model returned.
 *
 * Models wrap titles in quotes, prefix them with "Title:", and add a full stop,
 * despite being asked not to. Stripping that here is cheaper and more reliable
 * than another round trip.
 */
export function parseModelTitle(raw: string): string {
  let text = raw.trim();
  // Take the first line: a model that explains itself does so afterwards.
  text = text.split(/\r?\n/)[0] ?? '';
  text = text.replace(/^\s*(?:title|session|name)\s*[:\-–]\s*/i, '');
  text = text.replace(WRAPPING_QUOTES, '');
  text = text.replace(/[.。]+$/, '');
  return normalizeSessionTitle(text);
}

export type TitleSource = 'fallback' | 'model' | 'user';

export interface SessionTitle {
  title: string;
  source: TitleSource;
  provider?: string;
  model?: string;
}

/**
 * The session's current title: the last one logged.
 *
 * Reading the log rather than holding state means a title is correct after a
 * resume, a reconnect, or a process restart without anything having to be
 * rebuilt or kept in sync.
 */
export function currentTitle(session: Session): SessionTitle | undefined {
  for (let i = session.events.length - 1; i >= 0; i--) {
    const event = session.events[i];
    if (event?.type === 'session/title') {
      return event.data as SessionTitle;
    }
  }
  return undefined;
}

/**
 * Whether an automatic title should still be written.
 *
 * False once a user has renamed the session — a rename is a decision, and
 * quietly overwriting it minutes later with a model's guess is the single most
 * annoying thing this feature could do.
 */
export function acceptsAutomaticTitle(session: Session, next: TitleSource): boolean {
  const current = currentTitle(session);
  if (!current) return true;
  if (current.source === 'user') return false;
  // A model title replaces a fallback; a fallback never replaces a model title.
  if (current.source === 'model') return next === 'user';
  return true;
}
