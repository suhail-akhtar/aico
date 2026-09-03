/**
 * Adversarial check on the session-title sanitizer.
 *
 * Every attack string is built with String.fromCharCode rather than written
 * literally, for the same reason the patterns themselves are: a file with real
 * ESC bytes in it does not survive the trip through tooling intact. This very
 * script had to be written to disk because the shell refused a command
 * containing raw control characters.
 */

// A store of this process's own — nothing below may touch ~/.aico. Must stay first.
import './lib/test-home.mjs';
import {
  normalizeSessionTitle, fallbackSessionTitle, parseModelTitle, truncateTitleUtf8,
  currentTitle, acceptsAutomaticTitle, buildTitleRequest,
  writeFallbackTitle, writeUserTitle, pickNamingModel,
  Session,
} from '../dist-test/test-exports.js';

const ch = (...codes) => String.fromCharCode(...codes);
const ESC = ch(0x1B);
const BEL = ch(0x07);

const ATTACKS = [
  ['OSC retitles the terminal window', ESC + ']0;PWNED' + BEL + 'Fix the auth bug'],
  ['OSC with no terminator', ESC + ']0;PWNED and everything after'],
  ['CSI colour codes', ESC + '[31mFix' + ESC + '[0m the auth bug'],
  ['CSI clears the screen', 'Fix' + ESC + '[2J' + ESC + '[H the auth bug'],
  ['CSI cursor movement', 'Fix' + ESC + '[10A' + ESC + '[2K the auth bug'],
  ['two-byte ESC control', 'Fix' + ESC + 'M the auth bug'],
  ['C1 CSI (single byte)', 'Fix' + ch(0x9B) + '31m the auth bug'],
  ['right-to-left override', 'Fix ' + ch(0x202E) + 'gnub htua eht' + ch(0x202C)],
  ['left-to-right embedding', ch(0x202A) + 'Fix the auth bug'],
  ['zero-width space', 'Fix' + ch(0x200B) + 'the' + ch(0xFEFF) + 'auth bug'],
  ['invisible separators', 'Fix' + ch(0x2060) + 'the' + ch(0x2064) + 'auth bug'],
  ['NUL and bell', 'Fix the' + ch(0x00) + BEL + 'auth bug'],
  ['newlines collapse to one line', 'Fix the\nauth\r\nbug'],
  ['tabs collapse', 'Fix\t\tthe\tauth bug'],
  ['DEL character', 'Fix the' + ch(0x7F) + ' auth bug'],
];

/** Anything that must never survive into a rendered title. */
const DANGEROUS = new RegExp(
  '[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F' +
  '\\u200B\\u200E\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u206F\\uFEFF]');

let pass = 0, fail = 0;
const check = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? `\n          ${extra}` : ''}`); }
};

console.log('\n-- normalizeSessionTitle strips every control sequence --');
for (const [name, input] of ATTACKS) {
  const out = normalizeSessionTitle(input);
  check(!DANGEROUS.test(out), name, `left: ${JSON.stringify(out)}`);
}

console.log('\n-- and keeps the readable text --');
check(normalizeSessionTitle(ESC + '[31mFix the auth bug' + ESC + '[0m') === 'Fix the auth bug',
  'colour codes are removed, words survive');
check(normalizeSessionTitle('Fix the\nauth\r\nbug') === 'Fix the auth bug',
  'newlines become single spaces');
check(normalizeSessionTitle('  Fix the auth bug  ') === 'Fix the auth bug', 'edges are trimmed');
check(normalizeSessionTitle('Naprawić błąd uwierzytelniania') === 'Naprawić błąd uwierzytelniania',
  'non-ASCII text is untouched');
check(normalizeSessionTitle('修复认证错误') === '修复认证错误', 'CJK is untouched');
check(normalizeSessionTitle('Fix the bug 🎉') === 'Fix the bug 🎉', 'emoji survive');

console.log('\n-- the fallback title --');
check(fallbackSessionTitle('Fix the flaky auth test') === 'Fix the flaky auth test',
  'a short prompt is used whole, with no ellipsis');
const long = fallbackSessionTitle('one two three four five six seven eight nine ten');
check(long === 'one two three four five six seven eight…', `long prompts elide at the word cap (${long})`);
check(fallbackSessionTitle('') === '', 'empty input yields an empty title, not an ellipsis');
check(fallbackSessionTitle('   ') === '', 'whitespace-only input yields empty');
check(!DANGEROUS.test(fallbackSessionTitle(ESC + ']0;X' + BEL + 'hello there friend')),
  'the fallback sanitizes too — it is user-pasted text');

console.log('\n-- UTF-8 truncation never splits a code point --');
for (const budget of [1, 2, 3, 4, 5, 6, 7, 8]) {
  const out = truncateTitleUtf8('日本語のテキスト', budget);
  check(!out.includes('�') && Buffer.byteLength(out, 'utf8') <= budget,
    `budget ${budget}: whole code points only (${JSON.stringify(out)})`);
}
const emoji = truncateTitleUtf8('🎉🎉🎉', 5);
check([...emoji].every(c => c === '🎉'), `a surrogate pair is not halved (${JSON.stringify(emoji)})`);
check(Buffer.byteLength(normalizeSessionTitle('x'.repeat(500)), 'utf8') <= 120,
  'the byte budget is enforced');

console.log('\n-- parseModelTitle cleans up what models actually return --');
check(parseModelTitle('"Fix the flaky auth test"') === 'Fix the flaky auth test', 'straight quotes stripped');
check(parseModelTitle('“Fix the auth test”') === 'Fix the auth test', 'curly quotes stripped');
check(parseModelTitle('Title: Fix the auth test') === 'Fix the auth test', 'a Title: prefix stripped');
check(parseModelTitle('Fix the auth test.') === 'Fix the auth test', 'trailing full stop stripped');
check(parseModelTitle('Fix the auth test\n\nThis title describes...') === 'Fix the auth test',
  'a model that explains itself afterwards is cut to the first line');
check(parseModelTitle('`Fix the auth test`') === 'Fix the auth test', 'backticks stripped');
check(parseModelTitle('   ') === '', 'blank output yields empty, so the caller can keep the fallback');
check(!DANGEROUS.test(parseModelTitle(ESC + ']0;evil' + BEL + 'Innocent title')),
  'a model title is sanitized — model output is reachable by anything in context');

console.log('\n-- the title request stays small --');
{
  const huge = 'x'.repeat(50_000);
  const request = buildTitleRequest(huge, huge);
  check(request.length < 4000, `an enormous turn is clipped before it is sent (${request.length} chars)`);
  check(request.includes('<user>'), 'the ask is included');
  const noReply = buildTitleRequest('do the thing', '');
  check(!noReply.includes('<assistant>'), 'an empty reply contributes no empty element');
}

console.log('\n-- precedence: a rename pins the name --');
{
  const session = new Session({ id: 't1', cwd: '/tmp', startedAt: 1 });
  check(currentTitle(session) === undefined, 'a new session has no title');

  writeFallbackTitle(session, 'Fix the flaky auth test in the login suite please');
  check(currentTitle(session).source === 'fallback', 'the first submit writes a fallback');
  check(currentTitle(session).title.startsWith('Fix the flaky auth test'), 'derived from the first message');

  check(acceptsAutomaticTitle(session, 'model') === true, 'a model title may replace a fallback');
  writeFallbackTitle(session, 'a completely different second message');
  check(currentTitle(session).title.startsWith('Fix the flaky auth test'),
    'a second fallback does not overwrite the first');

  session.append('session/title', {
    title: 'Fix flaky auth test', source: 'model',
    provider: 'deepseek', model: 'deepseek-v4-flash',
  });
  check(acceptsAutomaticTitle(session, 'fallback') === false, 'a fallback never replaces a model title');
  check(acceptsAutomaticTitle(session, 'model') === false,
    'and a model title is written once, not on every turn');

  writeUserTitle(session, 'My auth work');
  check(currentTitle(session).source === 'user', 'a rename is recorded');
  check(acceptsAutomaticTitle(session, 'model') === false,
    'and pins the name — automatic naming stops for good');
  check(acceptsAutomaticTitle(session, 'fallback') === false, 'for every automatic source');

  check(writeUserTitle(session, '   ') === undefined, 'a blank rename is refused');
  check(currentTitle(session).title === 'My auth work', 'leaving the previous name intact');

  const evil = new Session({ id: 't2', cwd: '/tmp', startedAt: 1 });
  writeUserTitle(evil, ESC + ']0;PWNED' + BEL + 'Innocent');
  check(!DANGEROUS.test(currentTitle(evil).title), 'even a user rename is sanitized');
}

console.log('\n-- the naming model is cheap and in-family --');
{
  check(pickNamingModel({}, 'claude-opus-5') === 'claude-haiku-4-5',
    'an Anthropic turn is named by Haiku, not by Opus');
  check(pickNamingModel({}, 'deepseek-v4-pro') === 'deepseek-v4-flash',
    'a DeepSeek turn is named by Flash');
  check(pickNamingModel({ sessionTitles: { model: 'my-model' } }, 'claude-opus-5') === 'my-model',
    'an explicit setting wins over both');
  check(pickNamingModel({ activeProvider: 'openai' }, 'some-unknown-model') === 'gpt-4o-mini',
    'an unrecognisable model falls back to the active family');
  check(pickNamingModel({}, 'some-unknown-model') === 'some-unknown-model',
    'and finally to the work model rather than guessing a vendor');
}

console.log(`\n  SESSION TITLES: ${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
