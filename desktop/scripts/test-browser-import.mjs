/**
 * Unit tests for the import centre and the password vault: password CSV
 * formats, the two timestamp epochs, merging history, Firefox bookmarks and
 * profiles.ini, addresses, the vault's sealed file (with a stand-in cipher),
 * which pages a password may be filled into, the weak / reused report — and,
 * with node:sqlite, reading a whole generated set of fake browser profiles
 * through a temporary copy that is gone afterwards.
 *
 *   node scripts/test-browser-import.mjs
 *   node scripts/test-browser-import.mjs --fixtures <dir>   write the fake profiles and stop
 *
 * The fixtures are fake: made-up history, bookmarks and addresses in the
 * layout the real browsers use, under a folder of your choosing. Point
 * LOCALAPPDATA / APPDATA (or HOME / XDG_CONFIG_HOME) at it to run the app
 * against them.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-desk-imp-'));

async function load(entry, name) {
  const file = path.join(out, `${name}.mjs`);
  await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile: file, logLevel: 'error' });
  return import(pathToFileURL(file).href);
}

let pass = 0; let fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); }
}
function throws(fn, pattern, label) {
  try { fn(); ok(false, label, 'did not throw'); }
  catch (err) { ok(pattern.test(err.message), label, err.message); }
}

const C = await load(path.join(desktop, 'electron/browser-import-core.ts'), 'core');
const V = await load(path.join(desktop, 'electron/browser-vault-core.ts'), 'vault');
const R = await load(path.join(desktop, 'electron/browser-import-read.ts'), 'read');

// ── Fixtures: fake browser profiles, laid out where each OS keeps them ──

const chromeTime = (ms) => String((ms + 11_644_473_600_000) * 1000);
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 5, 1);

async function makeFixtures(root) {
  const { DatabaseSync } = await import('node:sqlite');
  const env = { LOCALAPPDATA: path.join(root, 'Local'), APPDATA: path.join(root, 'Roaming'), XDG_CONFIG_HOME: path.join(root, '.config') };
  const roots = C.browserRoots(process.platform, env, root);
  const dirOf = (b) => roots.find(r => r.browser === b).dir;
  const sql = (file, stmts) => { const db = new DatabaseSync(file); for (const s of stmts) db.exec(s); db.close(); };

  // Chrome: two profiles with names in Local State.
  const chrome = dirOf('Chrome');
  fs.mkdirSync(path.join(chrome, 'Default'), { recursive: true });
  fs.mkdirSync(path.join(chrome, 'Profile 1'), { recursive: true });
  fs.writeFileSync(path.join(chrome, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'Personal' }, 'Profile 1': { name: 'Work' } } } }));
  const bm = (name, url) => ({ type: 'url', name, url, date_added: chromeTime(T0) });
  fs.writeFileSync(path.join(chrome, 'Default', 'Bookmarks'), JSON.stringify({ roots: {
    bookmark_bar: { children: [bm('Fake News Site', 'https://news.example.test/'), { type: 'folder', name: 'Recipes', children: [bm('Soup', 'https://food.example.test/soup')] }, bm('Bookmarklet', 'javascript:alert(1)')] },
    other: { children: [bm('Docs', 'https://docs.example.test/')] },
  } }));
  fs.writeFileSync(path.join(chrome, 'Profile 1', 'Bookmarks'), JSON.stringify({ roots: { bookmark_bar: { children: [bm('Work wiki', 'https://wiki.example.test/')] } } }));
  sql(path.join(chrome, 'Default', 'History'), [
    'CREATE TABLE urls(id INTEGER PRIMARY KEY, url LONGVARCHAR, title LONGVARCHAR, visit_count INTEGER DEFAULT 0 NOT NULL, typed_count INTEGER DEFAULT 0 NOT NULL, last_visit_time INTEGER NOT NULL, hidden INTEGER DEFAULT 0 NOT NULL)',
    `INSERT INTO urls(url, title, visit_count, last_visit_time, hidden) VALUES
      ('https://news.example.test/', 'Fake News Site', 12, ${chromeTime(T0 + 2 * DAY)}, 0),
      ('https://food.example.test/soup#step2', 'Soup', 3, ${chromeTime(T0 + DAY)}, 0),
      ('https://docs.example.test/start', 'Docs start', 1, ${chromeTime(T0)}, 0),
      ('https://ads.example.test/redirect', 'hidden', 1, ${chromeTime(T0)}, 1),
      ('chrome://settings/', 'Settings', 5, ${chromeTime(T0)}, 0)`,
  ]);
  sql(path.join(chrome, 'Default', 'Web Data'), [
    'CREATE TABLE local_addresses(guid VARCHAR PRIMARY KEY, use_count INTEGER)',
    'CREATE TABLE local_addresses_type_tokens(guid VARCHAR, type INTEGER, value VARCHAR, verification_status INTEGER DEFAULT 0)',
    "INSERT INTO local_addresses VALUES ('g1', 3)",
    `INSERT INTO local_addresses_type_tokens(guid, type, value) VALUES ('g1', 7, 'Test Person'), ('g1', 77, '1 Fake Street\nFlat 2'), ('g1', 33, 'Testville'),
      ('g1', 35, 'TE5 7ST'), ('g1', 36, 'GB'), ('g1', 9, 'test.person@example.test'), ('g1', 14, '+44 20 0000 0000'), ('g1', 60, 'Example Ltd')`,
    // Cards sit in the same file: never read.
    'CREATE TABLE credit_cards(guid VARCHAR, name_on_card VARCHAR, card_number_encrypted BLOB)',
    "INSERT INTO credit_cards VALUES ('c1', 'Test Person', x'00112233')",
  ]);
  // A saved-password database that must never be opened: its mtime/content are checked after.
  fs.writeFileSync(path.join(chrome, 'Default', 'Login Data'), 'NOT A REAL DATABASE — AICO MUST NEVER READ THIS');

  // Edge: one profile, the older address tables.
  const edge = dirOf('Edge');
  fs.mkdirSync(path.join(edge, 'Default'), { recursive: true });
  sql(path.join(edge, 'Default', 'Web Data'), [
    'CREATE TABLE autofill_profiles(guid VARCHAR PRIMARY KEY, company_name VARCHAR, street_address VARCHAR, city VARCHAR, state VARCHAR, zipcode VARCHAR, country_code VARCHAR)',
    'CREATE TABLE autofill_profile_names(guid VARCHAR, first_name VARCHAR, middle_name VARCHAR, last_name VARCHAR, full_name VARCHAR)',
    'CREATE TABLE autofill_profile_emails(guid VARCHAR, email VARCHAR)',
    'CREATE TABLE autofill_profile_phones(guid VARCHAR, number VARCHAR)',
    "INSERT INTO autofill_profiles VALUES ('e1', '', '9 Sample Road', 'Exampleton', 'CA', '90000', 'US')",
    "INSERT INTO autofill_profile_names VALUES ('e1', 'Sam', '', 'Sample', '')",
  ]);

  // Firefox: profiles.ini with an [Install] default, places.sqlite, autofill-profiles.json.
  const ff = dirOf('Firefox');
  const prof = path.join(ff, 'Profiles', 'abcd1234.default-release');
  fs.mkdirSync(prof, { recursive: true });
  fs.writeFileSync(path.join(ff, 'profiles.ini'), '[Install308046B0AF4A39CB]\nDefault=Profiles/abcd1234.default-release\nLocked=1\n\n[Profile0]\nName=default-release\nIsRelative=1\nPath=Profiles/abcd1234.default-release\n\n[General]\nStartWithLastProfile=1\nVersion=2\n');
  const us = (ms) => ms * 1000;
  sql(path.join(prof, 'places.sqlite'), [
    'CREATE TABLE moz_places(id INTEGER PRIMARY KEY, url LONGVARCHAR, title LONGVARCHAR, visit_count INTEGER DEFAULT 0, hidden INTEGER DEFAULT 0 NOT NULL, last_visit_date INTEGER)',
    'CREATE TABLE moz_bookmarks(id INTEGER PRIMARY KEY, type INTEGER, fk INTEGER DEFAULT NULL, parent INTEGER, position INTEGER, title LONGVARCHAR, dateAdded INTEGER, lastModified INTEGER, guid TEXT)',
    `INSERT INTO moz_places VALUES (1, 'https://fox.example.test/', 'Fox home', 7, 0, ${us(T0 + 3 * DAY)}), (2, 'https://news.example.test/', 'News (Firefox)', 30, 0, ${us(T0 + 5 * DAY)}),
      (3, 'place:sort=8&maxResults=10', 'Recent', 0, 0, NULL), (4, 'https://menu.example.test/', 'In the menu', 0, 0, NULL)`,
    `INSERT INTO moz_bookmarks VALUES (1, 2, NULL, 0, 0, '', 0, 0, 'root________'), (2, 2, NULL, 1, 0, 'menu', 0, 0, 'menu________'),
      (3, 2, NULL, 1, 1, 'toolbar', 0, 0, 'toolbar_____'), (4, 2, NULL, 1, 2, 'tags', 0, 0, 'tags________'), (5, 2, NULL, 1, 3, 'unfiled', 0, 0, 'unfiled_____'),
      (6, 2, NULL, 1, 4, 'mobile', 0, 0, 'mobile______'),
      (10, 1, 1, 3, 0, 'Fox home', ${us(T0)}, 0, 'bm10'), (11, 1, 3, 3, 1, 'Smart folder', ${us(T0)}, 0, 'bm11'),
      (12, 2, NULL, 3, 2, 'Reading', ${us(T0)}, 0, 'bm12'), (13, 1, 2, 12, 0, 'News', ${us(T0)}, 0, 'bm13'),
      (14, 1, 4, 2, 0, 'In the menu', ${us(T0)}, 0, 'bm14'), (15, 3, NULL, 3, 3, '', ${us(T0)}, 0, 'sep15')`,
  ]);
  fs.writeFileSync(path.join(prof, 'autofill-profiles.json'), JSON.stringify({
    version: 1,
    addresses: [{ 'given-name': 'Fox', 'family-name': 'Tester', 'street-address': '5 Firefox Way', 'address-level2': 'Foxton', 'postal-code': 'FX1 1FX', country: 'GB', tel: '+440000000001', email: 'fox@example.test' }],
    creditCards: [{ 'cc-name': 'Fox Tester', 'cc-number-encrypted': 'ENCRYPTED-NEVER-READ' }],
  }));
  fs.writeFileSync(path.join(prof, 'logins.json'), '{"note":"AICO must never read this"}');
  return env;
}

const fixturesArg = process.argv.indexOf('--fixtures');
if (fixturesArg > 0) {
  const dir = path.resolve(process.argv[fixturesArg + 1] ?? path.join(os.tmpdir(), 'aico-fake-browsers'));
  fs.mkdirSync(dir, { recursive: true });
  const env = await makeFixtures(dir);
  console.log(JSON.stringify({ root: dir, env }, null, 2));
  process.exit(0);
}

// ── CSV formats ──
{
  const chrome = 'name,url,username,password,note\r\nexample.test,https://example.test/login,alice,"pa,ss""word",\r\napp,android://abc@com.app/,bob,x,\r\nnopw,https://nopw.test/,carol,,\r\n';
  const r = C.mapPasswordCsv(chrome);
  ok(r.source === 'Chrome, Edge or Brave', 'csv: Chrome/Edge/Brave header is recognised', r.source);
  ok(r.logins.length === 1 && r.logins[0].origin === 'https://example.test' && r.logins[0].username === 'alice' && r.logins[0].password === 'pa,ss"word', 'csv: quoted commas and doubled quotes survive; the URL becomes its origin', r.logins);
  ok(r.skipped === 2 && r.reasons['no password'] === 1 && Object.keys(r.reasons).some(k => /app/.test(k)), 'csv: an android:// login and a row with no password are skipped with reasons', r.reasons);

  const ff = '"url","username","password","httpRealm","formActionOrigin","guid","timeCreated","timeLastUsed","timePasswordChanged"\n"https://fox.test","fox","f0x-Pass!",,"https://fox.test","{g}","1700000000000","1700000000000","1700000000000"\n"chrome://FirefoxAccounts","x","y",,,,,,\n';
  const f = C.mapPasswordCsv(ff);
  ok(f.source === 'Firefox' && f.logins.length === 1 && f.logins[0].created === 1_700_000_000_000 && f.skipped === 1, 'csv: Firefox export (with its creation time; the Firefox-account row skipped)', f);

  const safari = 'Title,URL,Username,Password,Notes,OTPAuth\nApple,https://appleid.example.test/,me@example.test,S4fari!pw,"line one\nline two",otpauth://totp/x?secret=ABC\n';
  const s = C.mapPasswordCsv(safari);
  ok(s.source === 'Safari' && s.logins[0].note === 'line one\nline two' && !JSON.stringify(s.logins).includes('otpauth'), 'csv: Safari export — multi-line note kept, OTP secret not imported', s.logins);

  const bw = 'folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n,,login,Site,,,,"androidapp://x,https://bw.test/signin",bwuser,bwPass#1,JBSWY3DP\n,,card,Visa,,,,,,,\n,,note,Secret note,text,,,,,,\n';
  const b = C.mapPasswordCsv(bw);
  ok(b.source === 'Bitwarden' && b.logins.length === 1 && b.logins[0].origin === 'https://bw.test' && b.logins[0].username === 'bwuser', 'csv: Bitwarden — first web URI of several, login rows only', b.logins);
  ok(b.reasons['not a login (card, note or identity)'] === 2, 'csv: Bitwarden cards and notes are skipped', b.reasons);

  const op = '\uFEFFTitle,Website,Username,Password,One-time password,Favorite status,Archived status,Tags,Notes\nMail,mail.example.test,op-user,0nePass!,,false,false,,a note\n';
  const o = C.mapPasswordCsv(op);
  ok(o.source === '1Password' && o.logins[0].origin === 'https://mail.example.test' && o.logins[0].note === 'a note', '1Password — BOM, bare domain becomes https', o.logins);

  throws(() => C.mapPasswordCsv('a,b,c\n1,2,3\n'), /does not look like a password export/, 'csv: a file with no URL / password columns is refused');
  ok(C.parseCsv('a,"b\r\nc",d\r\n\r\ne,f,g').length === 2 && C.parseCsv('a,"b\r\nc",d')[0][1] === 'b\r\nc', 'csv: line breaks inside quotes stay in the field; blank lines are dropped');
  ok(C.originFromUrl('javascript:alert(1)') === null && C.originFromUrl('https://user:pw@evil.test/x') === 'https://evil.test' && C.originFromUrl('HTTPS://EXAMPLE.TEST:443/a') === 'https://example.test', 'csv: origins are parsed, not guessed (javascript: refused, credentials dropped, default port folded)');
}

// ── Time ──
{
  const ms = Date.UTC(2024, 0, 1);
  ok(C.fromWebkitTime(String((ms + 11_644_473_600_000) * 1000)) === ms, 'time: Chromium 1601-epoch microseconds → ms', C.fromWebkitTime(String((ms + 11_644_473_600_000) * 1000)));
  ok(C.fromFirefoxTime(ms * 1000) === ms, 'time: Firefox microseconds → ms');
  ok(C.fromFirefoxTime(0) === undefined && C.fromFirefoxTime(ms) === undefined && C.fromChromiumTime('0') === undefined, 'time: zero and wrong-unit values are dropped, not turned into 1970 or 1601');
}

// ── History merge ──
{
  const existing = [{ url: 'https://a.test/', title: 'A (AICO)', visits: 4, lastVisit: 1000 }, { url: 'https://b.test/', title: 'https://b.test/', visits: 1, lastVisit: 500 }];
  const incoming = [
    { url: 'https://a.test/#frag', title: 'A (Chrome)', visits: 9, lastVisit: 900 },
    { url: 'https://b.test/', title: 'B', visits: 1, lastVisit: 2000 },
    { url: 'https://c.test/', title: 'C', visits: 2, lastVisit: 1500 },
  ];
  const m = C.mergeHistory(existing, incoming);
  const a = m.list.find(e => e.url === 'https://a.test/');
  ok(m.list.length === 3 && a.visits === 9 && a.lastVisit === 1000 && a.title === 'A (AICO)', 'history: one entry per URL (fragment dropped); larger count and later date win; AICO’s title kept', a);
  ok(m.list.find(e => e.url === 'https://b.test/').title === 'B', 'history: an entry titled with its own URL takes the imported title');
  ok(m.added === 1 && m.updated === 2 && m.list.map(e => e.url).join() === 'https://b.test/,https://c.test/,https://a.test/', 'history: newest first; counts added / updated', m);
  const again = C.mergeHistory(m.list, incoming);
  ok(again.added === 0 && again.updated === 0 && JSON.stringify(again.list) === JSON.stringify(m.list), 'history: importing the same profile twice changes nothing');
  const big = Array.from({ length: 30 }, (_, i) => ({ url: `https://n${i}.test/`, title: '', visits: 1, lastVisit: 10_000 + i }));
  const capped = C.mergeHistory(existing, big, 10);
  ok(capped.list.length === 10 && capped.list[0].url === 'https://n29.test/' && !capped.list.some(e => e.url === 'https://b.test/'), 'history: capped like AICO’s own (the oldest fall off)');
  ok(C.chromiumHistory([{ url: 'chrome://x', title: '', visit_count: 1, last_visit_time: chromeTime(T0) }, { url: 'file:///c:/x', visit_count: 1, last_visit_time: chromeTime(T0) }]).length === 0, 'history: browser pages and files are not imported');
}

// ── Firefox bookmarks, profiles.ini, profile folders ──
{
  const rows = [
    { id: 1, type: 2, parent: 0, position: 0, title: '', dateAdded: 0, guid: 'root________', url: null },
    { id: 2, type: 2, parent: 1, position: 0, title: 'menu', dateAdded: 0, guid: 'menu________', url: null },
    { id: 3, type: 2, parent: 1, position: 1, title: 'toolbar', dateAdded: 0, guid: 'toolbar_____', url: null },
    { id: 4, type: 2, parent: 1, position: 2, title: 'tags', dateAdded: 0, guid: 'tags________', url: null },
    { id: 5, type: 2, parent: 1, position: 3, title: 'unfiled', dateAdded: 0, guid: 'unfiled_____', url: null },
    { id: 11, type: 1, parent: 3, position: 1, title: 'Second', dateAdded: T0 * 1000, guid: 'x1', url: 'https://two.test/' },
    { id: 10, type: 1, parent: 3, position: 0, title: 'First', dateAdded: T0 * 1000, guid: 'x0', url: 'https://one.test/' },
    { id: 12, type: 1, parent: 3, position: 2, title: 'Query', dateAdded: 0, guid: 'x2', url: 'place:sort=8' },
    { id: 13, type: 1, parent: 4, position: 0, title: 'tagged', dateAdded: 0, guid: 'x3', url: 'https://tag.test/' },
    { id: 14, type: 1, parent: 5, position: 0, title: 'Loose', dateAdded: 0, guid: 'x4', url: 'https://loose.test/' },
    { id: 15, type: 1, parent: 2, position: 0, title: 'Menu item', dateAdded: 0, guid: 'x5', url: 'https://menu.test/' },
  ];
  const t = C.firefoxBookmarkTree(rows);
  ok(t.bar.map(n => n.title).join() === 'First,Second' && t.bar[0].addedAt === T0, 'firefox: toolbar → bar, in position order, µs dates converted', t.bar);
  ok(t.skipped === 1 && t.other.length === 2 && t.other[0].title === 'Bookmarks menu' && t.other[1].url === 'https://loose.test/' && !JSON.stringify(t).includes('tag.test'), 'firefox: place: queries skipped; menu in its own folder; tags are not bookmarks', t.other);

  const ini = '[Install4F96D1932A9F858E]\nDefault=Profiles/b.work\n\n[Profile1]\nName=work\nIsRelative=1\nPath=Profiles/b.work\n\n[Profile0]\nName=default\nIsRelative=0\nPath=D:\\FF\\abs\nDefault=1\n';
  const profs = C.parseProfilesIni(ini, 'C:\\Users\\x\\AppData\\Roaming\\Mozilla\\Firefox', '\\');
  ok(profs.length === 2 && profs[0].name === 'work' && profs[0].isDefault && profs[0].path === 'C:\\Users\\x\\AppData\\Roaming\\Mozilla\\Firefox\\Profiles\\b.work' && profs[1].path === 'D:\\FF\\abs' && !profs[1].isDefault,
    'firefox: profiles.ini — relative and absolute paths; [Install] Default wins over Default=1', profs);
  ok(C.chromiumProfileDirs(['Default', 'Profile 10', 'Profile 2', 'System Profile', 'Crashpad'], false).join() === 'Default,Profile 2,Profile 10', 'chromium: profile folders only, Default first, numeric order');
  ok(C.chromiumProfileDirs(['Bookmarks', 'History'], true).join() === '.', 'chromium: Opera keeps its one profile in the folder itself');
  const roots = C.browserRoots('win32', { LOCALAPPDATA: 'L:', APPDATA: 'R:' }, 'H:');
  ok(['Chrome', 'Edge', 'Brave', 'Vivaldi', 'Chromium', 'Opera', 'Opera GX', 'Firefox'].every(b => roots.some(r => r.browser === b)) && roots.find(r => r.browser === 'Firefox').dir === 'R:\\Mozilla\\Firefox',
    'discovery: Chrome, Edge, Brave, Vivaldi, Chromium, Opera, Opera GX and Firefox — from LOCALAPPDATA / APPDATA', roots.map(r => r.browser));
}

// ── Addresses ──
{
  const tok = C.chromiumAddressesTokens([{ guid: 'g', type: 3, value: 'Ann' }, { guid: 'g', type: 5, value: 'Lee' }, { guid: 'g', type: 30, value: '1 Road' }, { guid: 'g', type: 31, value: 'Flat 3' }, { guid: 'g', type: 33, value: 'Town' }, { guid: 'g', type: 35, value: 'AB1' }, { guid: 'g', type: 36, value: 'GB' }]);
  ok(tok.length === 1 && tok[0].name === 'Ann Lee' && tok[0].line1 === '1 Road' && tok[0].line2 === 'Flat 3' && tok[0].postalCode === 'AB1', 'addresses: Chromium type tokens (names and address lines)', tok);
  const leg = C.chromiumAddressesLegacy({ profiles: [{ guid: 'p', street_address: 'A St\nUnit 4', city: 'C', zipcode: '1', country_code: 'US', company_name: 'Co' }], names: [{ guid: 'p', first_name: 'Bo', last_name: 'Ma' }], phones: [{ guid: 'p', number: '555' }] });
  ok(leg[0].name === 'Bo Ma' && leg[0].line2 === 'Unit 4' && leg[0].phone === '555' && leg[0].company === 'Co', 'addresses: Chromium legacy tables joined by guid', leg);
  const ffa = C.firefoxAddresses(JSON.stringify({ addresses: [{ 'given-name': 'F', 'family-name': 'X', 'street-address': 'S', 'address-level2': 'T', 'postal-code': 'P', country: 'DE' }, { deleted: true }], creditCards: [{ 'cc-number': '4111111111111111' }] }));
  ok(ffa.length === 1 && ffa[0].name === 'F X' && !JSON.stringify(ffa).includes('4111'), 'addresses: Firefox autofill-profiles.json (cards ignored)', ffa);
  const base = { fullName: '', givenName: '', familyName: '', email: 'mine@x.test', phone: '', company: '', jobTitle: '', addresses: [{ id: 'a1', label: 'Home', line1: '1 Road', city: 'Town', postalCode: 'AB1', country: 'GB' }], deliveryNotes: '', updatedAt: 0 };
  const mm = C.mergeAddresses(base, [...tok, { line1: '2 Lane', city: 'X', postalCode: 'Z9', country: 'GB', name: 'Ann Lee', phone: '07000' }], 'Chrome');
  ok(mm.added === 1 && mm.skipped === 1 && mm.profile.addresses.length === 2 && mm.profile.addresses[1].label === 'Chrome 1', 'addresses: an address AICO already has is skipped; new ones are labelled by browser', mm);
  ok(mm.profile.email === 'mine@x.test' && mm.profile.fullName === 'Ann Lee' && mm.profile.phone === '07000', 'addresses: only empty profile details are filled in from the import');
}

// ── The vault file ──
const fakeCipher = (on = true) => ({
  available: () => on,
  encrypt: (s) => Buffer.from(Buffer.from(`ENC:${s}`, 'utf8').map(b => b ^ 0x5a)),
  decrypt: (b) => { const s = Buffer.from(b.map(x => x ^ 0x5a)).toString('utf8'); if (!s.startsWith('ENC:')) throw new Error('bad key'); return s.slice(4); },
});
{
  let d = V.emptyVault();
  let r = V.upsertLogin(d, { origin: 'https://bank.test/login?x=1', username: ' ann ', password: 'Correct-Horse-9' }, 1000); d = r.data;
  ok(r.result === 'added' && d.entries[0].origin === 'https://bank.test' && d.entries[0].username === 'ann', 'vault: a login is saved under its origin');
  r = V.upsertLogin(d, { origin: 'https://bank.test', username: 'ann', password: 'Correct-Horse-9' }, 2000);
  ok(r.result === 'unchanged' && r.data === d, 'vault: the same login again changes nothing');
  r = V.upsertLogin(d, { origin: 'https://bank.test', username: 'ann', password: 'New-Password-10' }, 3000); d = r.data;
  ok(r.result === 'updated' && d.entries.length === 1 && d.entries[0].updated === 3000 && d.entries[0].created === 1000, 'vault: a new password for the same account updates it');
  throws(() => V.upsertLogin(d, { origin: 'javascript:alert(1)', username: 'x', password: 'y' }, 1), /web address/, 'vault: a login without a web origin is refused');
  d = V.upsertLogin(d, { origin: 'https://bank.test', username: 'bob', password: 'Other-Pass-11' }, 4000).data;
  throws(() => V.editEntry(d, d.entries[1].id, { username: 'ann' }, 5000), /already saved/, 'vault: editing into a duplicate account is refused');
  d = { ...d, never: ['https://never.test'] };
  const sealed = V.sealVault(d, fakeCipher());
  ok(!sealed.toString('utf8').includes('New-Password-10') && !sealed.toString('latin1').includes('bank.test'), 'vault: nothing readable in the sealed file');
  const back = V.openVault(sealed, fakeCipher());
  ok(JSON.stringify(back) === JSON.stringify(d), 'vault: seal → open round trip', back);
  throws(() => V.sealVault(d, fakeCipher(false)), /not available/, 'vault: with no encryption available, nothing is written');
  throws(() => V.openVault(Buffer.from('{"entries":[]}'), fakeCipher()), /not an AICO password vault/, 'vault: a plain JSON file is not accepted as a vault');
  const tampered = Buffer.concat([sealed.subarray(0, 11), Buffer.from('garbage')]);
  throws(() => V.openVault(tampered, fakeCipher()), /bad key|JSON/, 'vault: a file that does not decrypt is an error, not an empty vault');
}

// ── Where a password may be filled ──
{
  const o = 'https://bank.test';
  const yes = (top, frame) => V.canFill(o, top, frame).ok;
  ok(yes('https://bank.test/login') && yes('https://BANK.test:443/x?y#z'), 'fill: the exact origin (case and default port folded)');
  ok(!yes('https://www.bank.test/login') && !yes('https://login.bank.test/'), 'fill: refused on a subdomain');
  ok(!yes('https://bank.test.evil.test/') && !yes('https://evilbank.test/') && !yes('https://evil.test/?https://bank.test') && !yes('https://evil.test/#https://bank.test'), 'fill: refused on look-alike hosts and URLs that merely mention the site');
  ok(!yes('https://bank.test@evil.test/') && !yes('https://bank.test:8443/') && !yes('https://bank.test./'), 'fill: refused for credentials-in-URL, another port, a trailing-dot host');
  ok(!yes('http://bank.test/login'), 'fill: refused on http');
  ok(!V.canFill('http://bank.test', 'http://bank.test/').ok, 'fill: even an http login is never filled over http');
  ok(!yes('https://bank.test/', 'https://ads.test/frame') && !yes('https://evil.test/', 'https://bank.test/'), 'fill: refused into a frame of another origin, and into bank.test framed by another site');
  ok(!V.canFill('https://xn--bnk-sna.test', 'https://bank.test/').ok && !yes('https://bаnk.test/'), 'fill: an IDN look-alike (Cyrillic а) is another origin');
  ok(V.canFill('http://localhost:5173', 'http://localhost:5173/login').ok && V.canFill('http://127.0.0.1:8080', 'http://127.0.0.1:8080/').ok && !V.canFill('http://localhost:5173', 'http://localhost:5174/').ok, 'fill: http on this machine’s loopback is allowed, exact port only');
  ok(!V.canFill(o, 'about:blank').ok && !V.canFill(o, 'data:text/html,x').ok, 'fill: never into blank or data: pages');
  const d = { v: 1, never: [], entries: [
    { id: '1', origin: 'https://bank.test', username: 'a', password: 'p', created: 0, updated: 1 },
    { id: '2', origin: 'https://www.bank.test', username: 'b', password: 'p', created: 0, updated: 2 },
    { id: '3', origin: 'https://bank.test', username: 'c', password: 'q', created: 0, updated: 3 },
  ] };
  ok(V.entriesFor(d, 'https://bank.test/login').map(e => e.id).join() === '3,1', 'fill: the chooser lists only this origin’s logins, most recent first');
}

// ── Report and export ──
{
  const e = (id, origin, username, password) => ({ id, origin, username, password, created: 0, updated: 0 });
  const list = [e('1', 'https://a.test', 'u', 'password'), e('2', 'https://b.test', 'bob', 'bob'), e('3', 'https://c.test', 'x', 'Long-And-Strong-42!'),
    e('4', 'https://d.test', 'y', 'Long-And-Strong-42!'), e('5', 'https://github.test', 'z', 'mygithubpass99X'), e('6', 'https://e.test', 'w', 'abcdefgh'), e('7', 'https://c.test', 'x2', 'Uniq-9f!kQ2')];
  const r = V.passwordReport(list);
  const reason = (id) => r.weak.find(w => w.id === id)?.reason;
  ok(/common/.test(reason('1')) && /shorter|same as the username/.test(reason('2')) && /site/.test(reason('5')) && /one kind/.test(reason('6')) && !reason('3') && !reason('7'), 'report: common, short, username, site-name and one-class passwords are weak; strong ones are not', r.weak);
  ok(r.reused.length === 1 && r.reused[0].join() === '3,4', 'report: a password shared by two sites is reused', r.reused);
  ok(!JSON.stringify(r).includes('Long-And-Strong'), 'report: carries ids and reasons, never passwords');
  const csv = V.toPasswordCsv([e('1', 'https://a.test', 'ann', 'p,"q"\nr'), { ...e('2', 'https://b.test:8443', '', 'x'), note: 'n' }]);
  const back = C.mapPasswordCsv(csv);
  ok(back.source === 'Chrome, Edge or Brave' && back.logins.length === 2 && back.logins[0].password === 'p,"q"\nr' && back.logins[1].origin === 'https://b.test:8443' && back.logins[1].note === 'n', 'export: Chrome-format CSV that imports back unchanged', back.logins);
}

// ── The agent's request only pre-selects ──
{
  const p = C.presetFor('google chrome', ['Bookmarks', 'hist', 'passwords', 'cookies'], true);
  ok(p.browser === 'Chrome' && p.parts.join() === 'bookmarks,history' && p.passwords === true, 'agent: "google chrome, bookmarks + history" becomes a preset; passwords/cookies are not parts', p);
  ok(JSON.stringify(C.presetFor('netscape', 'everything', 'yes')) === '{}', 'agent: unknown words pre-select nothing');
}

// ── Backups never carry the vault ──
{
  const B = await load(path.join(desktop, 'electron/backup-core.ts'), 'backup');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-imp-home-'));
  fs.mkdirSync(path.join(home, 'desktop', 'browser'), { recursive: true });
  fs.writeFileSync(path.join(home, 'desktop', 'prefs.json'), '{}');
  fs.writeFileSync(path.join(home, 'desktop', 'browser', 'vault.bin'), 'sealed');
  const all = [...B.collect(home, { includeChats: true }).values()].flat();
  ok(all.includes('desktop/prefs.json') && !all.some(f => /vault/.test(f)), 'backup: the vault is not collected', all);
  ok(B.categoryOf('desktop/browser/vault.bin') === null && B.categoryOf('desktop\\browser\\vault.bin') === null, 'backup: a vault inside a backup is never restored');
  fs.rmSync(home, { recursive: true, force: true });
}

// ── Reading fake profiles with node:sqlite ──
{
  let sqliteOk = true;
  try { await import('node:sqlite'); } catch { sqliteOk = false; }
  if (!sqliteOk) {
    console.log('  skip  profiles: node:sqlite is not available in this Node (Electron 44 has it)');
  } else {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-fake-browsers-'));
    const env = await makeFixtures(root);
    const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
    const guarded = (C.browserRoots(process.platform, env, root)).flatMap(r => [path.join(r.dir, 'Default', 'History'), path.join(r.dir, 'Default', 'Login Data'), path.join(r.dir, 'Profiles', 'abcd1234.default-release', 'places.sqlite')]).filter(f => fs.existsSync(f));
    const before = Object.fromEntries(guarded.map(f => [f, [sha(f), fs.statSync(f).mtimeMs]]));
    const tmpBefore = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('aico-import-')).length;

    const found = R.findProfiles(process.platform, env, root);
    const names = found.map(p => `${p.browser}/${p.profile}`);
    ok(names.join() === 'Chrome/Personal,Chrome/Work,Edge/Default,Firefox/default-release', 'profiles: found by browser and profile name (Local State, profiles.ini)', names);
    const chrome = found[0]; const edge = found[2]; const fox = found[3];
    const cc = await R.scanProfile(chrome);
    ok(cc.bookmarks === 3 && cc.history === 3 && cc.addresses === 1 && !cc.errors, 'profiles: Chrome counts — 3 bookmarks (bookmarklet not counted), 3 history (hidden and chrome:// not), 1 address', cc);
    const fc = await R.scanProfile(fox);
    ok(fc.bookmarks === 3 && fc.history === 2 && fc.addresses === 1 && !fc.errors, 'profiles: Firefox counts from places.sqlite and autofill-profiles.json', fc);
    const ec = await R.scanProfile(edge);
    ok(ec.addresses === 1 && ec.bookmarks === undefined, 'profiles: Edge’s older address tables are read', ec);

    const cd = await R.readProfile(chrome, { bookmarks: true, history: true, addresses: true });
    ok(cd.history.length === 3 && cd.history[0].url === 'https://news.example.test/' && cd.history[0].lastVisit === T0 + 2 * DAY, 'profiles: Chrome history read newest first with real dates', cd.history[0]);
    ok(cd.addresses[0].line2 === 'Flat 2' && cd.addresses[0].email === 'test.person@example.test' && !JSON.stringify(cd).includes('00112233'), 'profiles: Chrome address read; the card beside it is not', cd.addresses);
    ok(cd.bookmarks.bar.length === 2 && cd.bookmarks.skipped === 1, 'profiles: Chrome bookmarks read through the bookmarks importer');
    const fd = await R.readProfile(fox, { bookmarks: true, history: true, addresses: true });
    ok(fd.bookmarks.bar.map(n => n.title).join() === 'Fox home,Reading' && fd.history.length === 2 && fd.addresses[0].name === 'Fox Tester', 'profiles: Firefox bookmarks (toolbar), history and address read', fd.bookmarks.bar);

    const merged = C.mergeHistory([], [...cd.history, ...fd.history]);
    ok(merged.list.length === 4 && merged.list.find(e => e.url === 'https://news.example.test/').visits === 30, 'profiles: two browsers’ history merge into one list');

    const after = Object.fromEntries(guarded.map(f => [f, [sha(f), fs.statSync(f).mtimeMs]]));
    ok(guarded.length >= 3 && JSON.stringify(before) === JSON.stringify(after), 'profiles: the other browsers’ files are unchanged (content and mtime)', guarded.length);
    ok(fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('aico-import-')).length === tmpBefore, 'profiles: the temporary database copies are deleted');
    const locked = path.join(root, 'nope.sqlite');
    let msg = '';
    try { await R.withCopy(locked, 'Chrome', () => 1); } catch (err) { msg = err.message; }
    ok(/ENOENT|no such file/i.test(msg) && fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('aico-import-')).length === tmpBefore, 'profiles: a failed copy still removes its temp folder');
    fs.rmSync(root, { recursive: true, force: true });
  }
}

fs.rmSync(out, { recursive: true, force: true });
console.log(`\n  IMPORT/VAULT UNIT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
