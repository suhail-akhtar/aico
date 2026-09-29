/**
 * Browsing intelligence — unit tests for the pure model (electron/browser-learn-core.ts)
 * and the address bar's blending of its predictions (renderer ForYouSuggest.ts), with
 * synthetic timestamps: decay and frecency, routines, next-site prediction, tab
 * priority, unfinished things, research threads, the "Not interested" loop,
 * forgetting and excluding, clearing with history, and the caps.
 *
 *   node scripts/test-browser-learn.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-desk-learn-'));

async function load(entry, name) {
  const file = path.join(out, `${name}.mjs`);
  await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile: file, logLevel: 'error', external: ['electron'] });
  return import(pathToFileURL(file).href);
}

let pass = 0; let fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); }
}

const L = await load(path.join(desktop, 'electron/browser-learn-core.ts'), 'learn');
const S = await load(path.join(desktop, 'renderer/src/browser/ForYouSuggest.ts'), 'suggest');
const { DAY } = L;
const MIN = 60_000;
/** Local time. 2026-09-30 is a Wednesday. */
const at = (y, m, d, h, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const NOW = at(2026, 9, 30, 8, 30);
const visit = (d, url, t, o = {}) => L.learnVisit(d, { url, title: o.title ?? '', fromUrl: o.from, inPage: o.inPage }, t);

// ── Time, addresses ──
console.log('\nTime and addresses');
ok(Math.abs(L.decay(8, 0, 14 * DAY, 14) - 4) < 1e-9, 'decay: one half-life halves');
ok(L.decay(8, 10, 5, 14) === 8, 'decay: nothing decays backwards in time');
ok(L.weekdayOf(L.dayIndex(NOW)) === 3 && !L.isWeekend(L.dayIndex(NOW)), '2026-09-30 is a Wednesday');
ok(L.dayIndex(at(2026, 10, 25, 23, 59)) + 1 === L.dayIndex(at(2026, 10, 26, 0, 1)), 'day index steps once across a daylight-saving change');
ok(L.slotOf(at(2026, 9, 30, 9)) === 0 && L.slotOf(at(2026, 10, 3, 20)) === 6 && L.slotOf(at(2026, 9, 30, 23)) === 3, 'slots: weekday morning, weekend evening, weekday night');
ok(L.hostKey('https://www.GitHub.com/x') === 'github.com' && L.hostKey('aico://newtab') === '' && L.hostKey('file:///c:/a') === '', 'hostKey: web only, without www');
ok(L.searchOf('https://www.google.com/search?q=standing+desk')?.q === 'standing desk', 'search: Google');
ok(L.searchOf('https://www.bing.com/search?q=a%20b')?.q === 'a b' && L.searchOf('https://www.youtube.com/results?search_query=lofi')?.q === 'lofi', 'search: Bing and YouTube');
ok(L.searchOf('https://www.google.com/maps/place/x') === null, 'search: other Google pages are not searches');
ok(L.guessKind('https://shop.example/cart') === 'cart' && L.guessKind('https://shop.example/checkout/pay') === 'checkout', 'kind from the address: cart, checkout');
ok(L.guessKind('https://github.com/a/b') === 'code' && L.guessKind('https://www.amazon.com/dp/B0X') === 'product', 'kind from the address: code, product');

// ── Frecency ──
console.log('\nFrecency and interests');
{
  const d = L.emptyLearn(NOW - 90 * DAY);
  for (let i = 0; i < 10; i++) visit(d, 'https://old.example/', NOW - 60 * DAY + i * MIN);
  for (let i = 0; i < 3; i++) visit(d, 'https://new.example/', NOW - DAY + i * 40 * MIN);
  ok(L.siteScore(d, 'new.example', NOW) > L.siteScore(d, 'old.example', NOW), 'frecency: 3 visits yesterday outrank 10 two months ago',
    [L.siteScore(d, 'new.example', NOW), L.siteScore(d, 'old.example', NOW)]);
  const before = L.siteScore(d, 'new.example', NOW);
  L.learnActive(d, 'https://new.example/', 30_000, NOW);
  ok(L.siteScore(d, 'new.example', NOW) > before, 'frecency: time on a page counts');
  visit(d, 'https://new.example/a', NOW, { from: 'https://new.example/' });
  ok(d.sites['new.example'].visits === 3, 'a page within the same site is not a new visit to it');
}
{
  const d = L.emptyLearn(NOW - 10 * DAY);
  for (let i = 0; i < 6; i++) { visit(d, 'https://github.com/a/b', NOW - i * DAY); visit(d, 'https://stackoverflow.com/questions/1', NOW - i * DAY + 5 * MIN); }
  visit(d, 'https://www.bbc.co.uk/news', NOW - DAY);
  const i = L.interests(d, NOW);
  ok(i[0]?.label === 'Programming' && i[0].sites.includes('github.com') && i[0].sites.includes('stackoverflow.com'), 'interests: sites summed by topic', i);
  ok(i.some(x => x.label === 'News'), 'interests: the bundled map knows bbc.co.uk');
  ok(L.topicOf('blog.unknown.dev', ['Understanding React Server Components']) === 'Programming', 'topics: titles decide for unknown sites');
}

// ── A month of synthetic browsing: routines and next-site ──
console.log('\nRoutines and next site');
const month = () => {
  const d = L.emptyLearn(NOW - 35 * DAY);
  for (let back = 35; back >= 1; back--) {
    const day = new Date(NOW - back * DAY);
    const y = day.getFullYear(); const m = day.getMonth() + 1; const dd = day.getDate();
    const weekend = day.getDay() === 0 || day.getDay() === 6;
    if (!weekend && back % 9 !== 0) {
      visit(d, 'https://github.com/', at(y, m, dd, 9, 5));
      visit(d, 'https://news.ycombinator.com/', at(y, m, dd, 9, 20), { from: 'https://github.com/' });
      if (back % 3 === 0) visit(d, 'https://stackoverflow.com/', at(y, m, dd, 9, 35), { from: 'https://news.ycombinator.com/' });
    }
    visit(d, 'https://www.youtube.com/', at(y, m, dd, 20, 10));
    visit(d, 'https://www.bbc.co.uk/news', at(y, m, dd, (back * 7) % 24, 0));
  }
  return d;
};
{
  const d = month();
  const r = L.routines(d, NOW);
  const gh = r.find(x => x.site === 'github.com');
  ok(gh && gh.label === 'Weekday mornings' && gh.hour === 9, 'routine: github.com on weekday mornings around 9', gh);
  ok(gh && gh.due && /of the last \d+ weekday mornings/.test(gh.why), 'routine: due now (Wednesday 8:30, not yet today), with counts in the why', gh?.why);
  ok(gh && gh.hits >= 18 && gh.hits / gh.days >= 0.8, 'routine: most weekday mornings hit', gh && [gh.hits, gh.days]);
  const yt = r.find(x => x.site === 'youtube.com');
  ok(yt && yt.label === 'Every evening' && !yt.due, 'routine: weekday + weekend evenings read "Every evening", not due in the morning', yt);
  ok(!r.some(x => x.site === 'bbc.co.uk'), 'routine: a site at scattered hours is not a routine');
  // Once it happens today it is no longer due.
  const d2 = month();
  visit(d2, 'https://github.com/', at(2026, 9, 30, 8, 10));
  ok(!L.routines(d2, NOW).find(x => x.site === 'github.com').due, 'routine: not due once opened today');

  const p = L.predict(d, NOW, { from: 'github.com' });
  ok(p[0]?.site === 'news.ycombinator.com' && /After github\.com you often open/.test(p[0].why), 'next site: Markov move from github.com', p.slice(0, 3));
  ok(!p.some(x => x.site === 'github.com'), 'next site: never the site you are on');
  const q = L.predict(d, NOW, { query: 'you' });
  ok(q.length === 1 && q[0].site === 'youtube.com', 'next site: filtered by what is typed', q.map(x => x.site));
  const fresh = L.predict(d, NOW, { from: 'nowhere.example' });
  ok(fresh.length > 0 && fresh.every(x => x.score > 0), 'next site: smoothed — an unknown start still predicts by frecency');
  ok(['github.com', 'news.ycombinator.com'].includes(fresh[0].site) && /weekday mornings/.test(fresh[0].why), 'next site: a routine due now is predicted with its reason', fresh[0]);

  // The loop: "Not interested" in a prediction hides it and weighs the site down.
  const before = L.siteScore(d, 'news.ycombinator.com', NOW);
  L.learnDismiss(d, 'next:news.ycombinator.com', NOW);
  ok(!L.predict(d, NOW, { from: 'github.com' }).some(x => x.site === 'news.ycombinator.com'), 'not interested: the prediction is hidden');
  ok(Math.abs(L.siteScore(d, 'news.ycombinator.com', NOW) - before / 2) < 1e-9, 'not interested: the site counts half from now on');
  L.learnAccept(d, 'next:stackoverflow.com', NOW);
  ok(d.accepted['stackoverflow.com'] === 1, 'used suggestion: counted for the site');
}

// ── Unfinished ──
console.log('\nUnfinished');
{
  const d = L.emptyLearn(NOW - 10 * DAY);
  const art = 'https://longreads.example/the-future-of-batteries';
  visit(d, art, NOW - 3 * 3600_000, { title: 'The future of batteries' });
  L.learnKind(d, art, 'article', NOW - 3 * 3600_000, 2000);
  L.learnActive(d, art, 40_000, NOW - 3 * 3600_000 + MIN, 0.2);
  const read = 'https://longreads.example/solid-state';
  visit(d, read, NOW - 4 * 3600_000, { title: 'Solid-state explained' });
  L.learnKind(d, read, 'article', NOW - 4 * 3600_000, 1500);
  for (let i = 0; i < 10; i++) L.learnActive(d, read, 60_000, NOW - 4 * 3600_000 + i * MIN, 0.5 + i * 0.05);
  visit(d, 'https://shop.example/cart', NOW - DAY);
  visit(d, 'https://shop2.example/cart', NOW - DAY);
  visit(d, 'https://shop2.example/order/confirmation', NOW - DAY + 5 * MIN, { from: 'https://shop2.example/cart' });
  const form = 'https://forms.example/apply';
  visit(d, form, NOW - 5 * 3600_000, { title: 'Apply for a library card' });
  L.learnKind(d, form, 'form', NOW - 5 * 3600_000);
  L.learnTyped(d, form, NOW - 5 * 3600_000 + MIN);
  visit(d, 'https://elsewhere.example/', NOW - 5 * 3600_000 + 3 * MIN, { from: form });
  const form2 = 'https://forms2.example/contact';
  visit(d, form2, NOW - 5 * 3600_000);
  L.learnKind(d, form2, 'form', NOW - 5 * 3600_000);
  L.learnTyped(d, form2, NOW - 5 * 3600_000 + MIN);
  visit(d, 'https://forms2.example/contact/thanks', NOW - 5 * 3600_000 + 2 * MIN, { from: form2 });
  visit(d, 'https://www.google.com/search?q=best+standing+desk', NOW - 3600_000);
  visit(d, 'https://www.google.com/search?q=python+asyncio', NOW - 3600_000);
  visit(d, 'https://docs.python.org/3/library/asyncio.html', NOW - 3600_000 + MIN, { from: 'https://www.google.com/search?q=python+asyncio' });
  const u = L.unfinished(d, NOW, [{ id: 'b9', url: form, title: 'Apply' }]);
  const by = (id) => u.find(x => x.id === id);
  ok(by(`read:${art}`) && /read under a minute of about 9 min, 20% scrolled/.test(by(`read:${art}`).why), 'unfinished: an article barely read, with how much', by(`read:${art}`)?.why);
  ok(!by(`read:${read}`), 'unfinished: an article read for 10 minutes is not');
  ok(by('cart:https://shop.example/cart') && !by('cart:https://shop2.example/cart'), 'unfinished: a cart with no order confirmation; a confirmed one is done');
  ok(by(`form:${form}`)?.action.type === 'tab' && by(`form:${form}`).action.tabId === 'b9', 'unfinished: a form typed into and left — its open tab is offered');
  ok(!by(`form:${form2}`), 'unfinished: a form followed by a page of the same site was sent');
  ok(by('search:best standing desk') && !by('search:python asyncio'), 'unfinished: a search with no result opened; one with a click is not');
  ok(u[0].kind === 'form', 'unfinished: a started form ranks first', u.map(x => x.kind));
  ok(!JSON.stringify(d).includes('library card number'), 'typing is recorded as a fact only (nothing typed is stored)');
  L.learnDismiss(d, `read:${art}`, NOW);
  ok(!L.unfinished(d, NOW).some(x => x.id === `read:${art}`), 'not interested: an unfinished item goes away');
}

// ── Tabs ──
console.log('\nTab priority');
{
  const d = L.emptyLearn(NOW - 10 * DAY);
  const tabs = [
    { id: 'b1', url: 'https://old.example/a', title: 'Old A' },
    { id: 'b2', url: 'https://busy.example/', title: 'Busy', active: false },
    { id: 'b3', url: 'https://pinned.example/', title: 'Pinned', pinned: true },
    { id: 'b4', url: 'https://forms.example/apply', title: 'Form' },
    { id: 'b5', url: 'https://front.example/', title: 'Front', active: true },
    { id: 'b6', url: 'https://old.example/b', title: 'Old B' },
  ];
  for (const t of tabs) L.tabAt(d, t.url, NOW - 5 * DAY);
  L.tabFocus(d, 'https://busy.example/', NOW - 3600_000);
  L.learnActive(d, 'https://busy.example/', 60_000, NOW - 3600_000);
  for (let i = 0; i < 19; i++) L.learnActive(d, 'https://busy.example/', 60_000, NOW - 3600_000 + i);
  visit(d, 'https://forms.example/apply', NOW - 5 * DAY);
  L.learnKind(d, 'https://forms.example/apply', 'form', NOW - 5 * DAY);
  L.learnTyped(d, 'https://forms.example/apply', NOW - 5 * DAY);
  const p = L.tabPriorities(d, tabs, NOW);
  const t = (id) => p.find(x => x.id === id);
  ok(t('b1').idle && t('b6').idle && /Not looked at for 5 days/.test(t('b1').why), 'tabs: 5 days unlooked-at is idle, with why');
  ok(!t('b3').idle && !t('b4').idle && !t('b5').idle, 'tabs: pinned, a started form and the tab in front are never idle');
  ok(t('b2').priority > t('b1').priority && p[0].id === 'b2', 'tabs: an hour-old tab with 20 minutes on it ranks first', p.map(x => [x.id, x.priority]));
  ok(/started a form/.test(t('b4').why), 'tabs: a started form says so');
  const v = L.buildView(d, NOW, { tabs });
  ok(v.cleanup && v.cleanup.tabs.length === 2, 'view: a clean-up card for the idle tabs', v.cleanup?.tabs.map(x => x.id));
  ok(/idle tab ids: .*b6/i.test(L.tabsText(p)), 'agent text: lists the idle tab ids');
  L.tabAt(d, 'https://old.example/a2', NOW, 'https://old.example/a');
  ok(d.tabs['https://old.example/a2']?.focus === NOW - 5 * DAY && !d.tabs['https://old.example/a'], 'tabs: a tab keeps its record when it navigates');
}

// ── Research threads ──
console.log('\nResearch threads');
const research = () => {
  const d = L.emptyLearn(NOW - 10 * DAY);
  const g = 'https://www.google.com/search?q=standing+desk';
  visit(d, g, NOW - 3 * DAY, { title: 'standing desk - Google Search' });
  visit(d, 'https://www.rtings.com/office/reviews/best/standing-desks', NOW - 3 * DAY + MIN, { from: g, title: 'The 5 Best Standing Desks of 2026' });
  visit(d, 'https://www.nytimes.com/wirecutter/reviews/best-standing-desk/', NOW - 3 * DAY + 20 * MIN, { title: 'The Best Standing Desk | Wirecutter' });
  visit(d, 'https://www.reddit.com/r/StandingDesk/comments/abc/', NOW - 2 * DAY, { title: 'Is a standing desk worth it? : r/StandingDesk' });
  visit(d, 'https://www.flexispot.com/e7-standing-desk', NOW - 2 * DAY + 5 * MIN, { title: 'Flexispot E7 Pro Standing Desk' });
  visit(d, 'https://www.google.com/search?q=standing+desk+frame+stability', NOW - DAY, { title: 'standing desk frame stability - Google Search' });
  visit(d, 'https://docs.python.org/3/library/asyncio.html', NOW - DAY, { title: 'asyncio — Asynchronous I/O' });
  visit(d, 'https://realpython.com/async-io-python/', NOW - DAY + MIN, { title: 'Async IO in Python: A Complete Walkthrough' });
  visit(d, 'https://stackoverflow.com/questions/42231161/asyncio-gather-vs-asyncio-wait', NOW - DAY + 2 * MIN, { title: 'python - Asyncio.gather vs asyncio.wait - Stack Overflow' });
  visit(d, 'https://www.bbc.co.uk/weather', NOW - DAY, { title: 'BBC Weather' });
  return d;
};
{
  const d = research();
  const th = L.threads(d, NOW);
  const desk = th.find(t => /desk/.test(t.label));
  ok(desk && desk.label === 'standing desk', 'threads: the standing-desk research, labelled by its search', th.map(t => t.label));
  ok(desk && desk.sites.length >= 4 && desk.queries.length === 2, 'threads: across sites, with both searches', desk && [desk.sites, desk.queries]);
  ok(desk && !desk.pages.some(p => /python|asyncio|weather/i.test(p.url)), 'threads: unrelated pages are not in it');
  ok(desk && /pages on \d+ sites, 2 searches/.test(desk.why) && desk.prompt.includes('rtings.com'), 'threads: why, and a copilot prompt with the pages', desk?.why);
  const py = th.find(t => /asyncio/.test(t.terms.join(' ')));
  ok(py && py.sites.length === 3, 'threads: the asyncio reading is its own thread', th.map(t => [t.label, t.sites]));
  ok(!th.some(t => /weather/i.test(t.label)), 'threads: a single page is not a thread');
  const v = L.buildView(d, NOW);
  ok(v.priorities.some(p => p.kind === 'thread' && p.action.type === 'ask'), 'priorities: a recent thread to pick up, asking the copilot');
  // Turning a thread down weighs its words down: it does not come back.
  L.learnDismiss(d, desk.id, NOW);
  ok(!L.threads(d, NOW).some(t => t.id === desk.id), 'not interested: the thread is hidden');
  ok(d.muted.terms.stand === 1 && d.muted.terms.desk === 1, 'not interested: its words (stems) are muted', d.muted.terms);
  const d2 = research();
  L.removeItem(d2, desk.id);
  ok(!d2.pages.some(p => /standing desk/i.test(p.title)) && !d2.queries.some(q => /desk/.test(q.q)), 'remove a thread: its pages and searches are forgotten');
}

// ── Forget, exclude, clear, caps ──
console.log('\nForgetting and caps');
{
  const d = research();
  L.setExcluded(d, 'https://www.reddit.com/r/x', true);
  ok(d.excluded.includes('reddit.com') && !d.sites['reddit.com'] && !d.pages.some(p => p.host === 'reddit.com'), 'exclude: normalised, and what was learned from it is forgotten');
  ok(L.isExcluded(d, 'old.reddit.com') && !L.isExcluded(d, 'notreddit.com'), 'exclude: covers subdomains only');
  L.setExcluded(d, 'reddit.com', false);
  ok(!d.excluded.includes('reddit.com'), 'exclude: can be undone');
  L.removeItem(d, 'site:rtings.com');
  ok(!d.sites['rtings.com'] && !Object.values(d.moves).some(r => r['rtings.com']), 'remove a site: it and its moves go');
  const m = month();
  L.removeItem(m, L.routines(m, NOW).find(r => r.site === 'github.com').id);
  ok(!L.routines(m, NOW).some(r => r.site === 'github.com' && r.label === 'Weekday mornings'), 'remove a routine: it is not learned back from the same days');
  m.paused = true; m.excluded = ['x.example'];
  const f = L.forgetAll(m, NOW);
  ok(f.paused && f.excluded[0] === 'x.example' && !Object.keys(f.sites).length && !f.pages.length, 'forget everything: keeps pause and exclusions only');

  const c = research();
  const cut = NOW - 1.5 * DAY;
  L.clearSince(c, NOW, cut);
  ok(!c.pages.some(p => p.last >= cut) && c.pages.some(p => /rtings/.test(p.url)), 'clear since: newer pages go, older stay');
  ok(!c.sites['realpython.com'] && Boolean(c.sites['rtings.com']), 'clear since: sites first seen since then go');
  ok(!c.queries.some(q => q.at >= cut), 'clear since: newer searches go');
  const all = L.clearSince(research(), NOW);
  ok(!Object.keys(all.sites).length, 'clear all history: everything learned goes');
  const r = research();
  L.forgetUrl(r, 'https://www.flexispot.com/e7-standing-desk#specs');
  ok(!r.pages.some(p => /flexispot/.test(p.url)), 'history remove: the page is forgotten here too');
}
{
  const d = L.emptyLearn(NOW - 100 * DAY);
  for (let i = 0; i < 520; i++) visit(d, `https://s${i}.example/p${i}`, NOW - (i % 50) * DAY - i);
  for (let i = 0; i < 700; i++) visit(d, `https://many.example/page/${i}`, NOW - i * MIN);
  visit(d, 'https://ancient.example/', NOW - 80 * DAY);
  L.pruneLearn(d, NOW);
  ok(Object.keys(d.sites).length <= L.CAPS.sites, 'caps: sites', Object.keys(d.sites).length);
  ok(d.pages.length <= L.CAPS.pages, 'caps: pages', d.pages.length);
  ok(Object.values(d.sites).every(s => Object.keys(s.seen).every(k => Number(k) > L.dayIndex(NOW) - L.ROUTINE_DAYS)), 'caps: days older than the routine window are dropped');
  ok(!d.pages.some(p => p.host === 'ancient.example'), 'caps: pages older than 60 days are dropped');
  ok(JSON.stringify(d).length < 400_000, 'caps: the file stays small', JSON.stringify(d).length);
}
{
  const g = L.normaliseLearn({ sites: { 'a.example': { score: 'x', hours: [1] } }, pages: [{ url: 'javascript:alert(1)' }, { url: 'https://ok.example/', title: 5 }], excluded: [3, 'B.example'], paused: 'yes' });
  ok(g.sites['a.example'].score === 0 && g.sites['a.example'].hours.length === 24, 'normalise: bad numbers and arrays are repaired');
  ok(g.pages.length === 1 && g.pages[0].title === '', 'normalise: non-web pages are dropped');
  ok(g.excluded.length === 1 && g.excluded[0] === 'b.example' && g.paused === false, 'normalise: exclusions cleaned, pause must be true to count');
  const round = L.normaliseLearn(JSON.parse(JSON.stringify(research())), NOW);
  ok(L.threads(round, NOW).some(t => t.label === 'standing desk'), 'normalise: a saved file reads back the same');
  ok(L.normaliseLearn(null, NOW).v === 1 && L.normaliseLearn('garbage', NOW).pages.length === 0, 'normalise: nothing or garbage is an empty model');
}

// ── Seeding and the agent's profile ──
console.log('\nSeeding and the profile');
{
  const d = L.emptyLearn(NOW);
  L.seedFromHistory(d, [{ url: 'https://github.com/x', title: 'x', visits: 40, lastVisit: NOW - DAY }, { url: 'aico://newtab', title: '', visits: 3, lastVisit: NOW }], NOW);
  ok(d.sites['github.com']?.visits === 40 && Object.keys(d.sites).length === 1, 'seed: from history, web pages only');
  const v = L.buildView(research(), NOW);
  const text = L.profileText(v);
  ok(/INTERESTS/.test(text) && /RESEARCH THREADS/.test(text) && /“standing desk”/.test(text), 'profile: sections and threads');
  ok(!/https?:\/\//.test(text), 'profile: no page addresses unless asked');
  ok(/https:\/\/www\.rtings\.com/.test(L.profileText(v, { includeUrls: true })), 'profile: addresses when asked');
  ok(!/INTERESTS/.test(L.profileText(v, { section: 'threads' })), 'profile: one section');
  ok(/Nothing has been learned yet/.test(L.profileText(L.buildView(L.emptyLearn(NOW), NOW))), 'profile: says so when empty');
}

// ── The address bar ──
console.log('\nAddress bar');
{
  const preds = [{ url: 'https://github.com/', title: 'github.com', site: 'github.com', why: 'You usually open it on weekday mornings.', score: 0.6 }];
  const rows = [
    { kind: 'search', url: 'https://www.google.com/search?q=git', title: 'git' },
    { kind: 'history', url: 'https://git-scm.com/', title: 'Git' },
    { kind: 'history', url: 'https://github.com/', title: 'GitHub' },
  ];
  const b = S.blendPredictions(rows, preds);
  ok(b[0].kind === 'search' && b[1].url === 'https://github.com/' && b[1].predicted && /weekday/.test(b[1].why), 'omnibox: a predicted match is lifted under what Enter does, with why', b.map(x => x.url));
  ok(b.length === 3 && b.filter(x => x.url === 'https://github.com/').length === 1, 'omnibox: never listed twice');
  const n = S.blendPredictions(rows.slice(0, 2), preds);
  ok(n[1].url === 'https://github.com/' && n[1].title === 'github.com', 'omnibox: a predicted site not in history is added');
  ok(S.blendPredictions(rows, [], 8).every((x, i) => x.url === rows[i].url), 'omnibox: without predictions nothing changes');
  ok(S.predictionRows(preds)[0].predicted, 'omnibox: nothing typed shows the predictions');
}

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(out, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
