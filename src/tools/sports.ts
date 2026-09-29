/**
 * `SportsScores` — scores, fixtures and league tables, ready for a ```sports
 * scoreboard card.
 *
 * Two keyless sources, used in a fixed order and always named:
 *
 *   1. ESPN's public site API — the scoreboard, standings and team schedules
 *      behind espn.com. Near-live for the major leagues (soccer, NFL, NBA,
 *      WNBA, MLB, NHL, college sports) and for the cricket leagues ESPNcricinfo
 *      carries. It is undocumented, so every field is read defensively.
 *   2. TheSportsDB (the public test key `3`) — only for a team ESPN cannot
 *      place: a national cricket side, a league not in the table below. The
 *      free key returns one past event and often no future ones; the result
 *      says so rather than implying that is the whole season.
 *
 * Neither is a guaranteed live feed. The block carries `source` and
 * `updatedAt` (when this lookup was made) so the card can say how fresh it is,
 * and the text tells the model a score in progress may already have moved.
 *
 * @module tools/sports
 */

import { requestJson, TtlCache, fencedBlock } from './net.js';

export interface SportsInput {
  sport?: string;
  league?: string;
  team?: string;
  date?: string;
  kind?: 'scores' | 'standings';
}

export interface SportsOptions {
  /** The clock "today" is read from. Tests pin it. */
  now?: Date;
}

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports';
const ESPN_STANDINGS = 'https://site.api.espn.com/apis/v2/sports';
const TSDB = 'https://www.thesportsdb.com/api/v1/json/3';

interface Cached<T> { value: T; at: string }
// A scoreboard with a match in progress moves by the minute, so it is kept
// only long enough to spare ESPN a model that asks twice in one step.
const scoreboardCache = new TtlCache<Cached<unknown>>(30 * 1000);
const slowCache = new TtlCache<Cached<unknown>>(10 * 60 * 1000);
const teamListCache = new TtlCache<Cached<unknown>>(6 * 60 * 60 * 1000);

export function resetSportsForTests(): void {
  scoreboardCache.clear();
  slowCache.clear();
  teamListCache.clear();
}

async function cachedJson<T>(cache: TtlCache<Cached<unknown>>, url: string, what: string): Promise<Cached<T>> {
  const hit = cache.get(url);
  if (hit) return hit as Cached<T>;
  const value = await requestJson<T>(url, { what });
  const entry = { value, at: new Date().toISOString() };
  cache.set(url, entry);
  return entry;
}

// ── Leagues ─────────────────────────────────────────────────────────

export interface League {
  /** ESPN's sport segment: soccer, basketball, football, baseball, hockey, cricket. */
  sport: string;
  /** ESPN's league segment: eng.1, nba, 8048… */
  league: string;
  name: string;
  aliases: string[];
}

/** Friendly names → ESPN paths. Every entry was checked against the live scoreboard. */
export const LEAGUES: League[] = [
  { sport: 'soccer', league: 'eng.1', name: 'Premier League', aliases: ['premier league', 'epl', 'english premier league', 'premiership', 'barclays premier league'] },
  { sport: 'soccer', league: 'eng.2', name: 'EFL Championship', aliases: ['championship', 'efl championship', 'english league championship'] },
  { sport: 'soccer', league: 'eng.fa', name: 'FA Cup', aliases: ['fa cup', 'english fa cup'] },
  { sport: 'soccer', league: 'esp.1', name: 'La Liga', aliases: ['la liga', 'laliga', 'spanish la liga', 'primera division'] },
  { sport: 'soccer', league: 'ita.1', name: 'Serie A', aliases: ['serie a', 'italian serie a'] },
  { sport: 'soccer', league: 'ger.1', name: 'Bundesliga', aliases: ['bundesliga', 'german bundesliga'] },
  { sport: 'soccer', league: 'fra.1', name: 'Ligue 1', aliases: ['ligue 1', 'french ligue 1'] },
  { sport: 'soccer', league: 'ned.1', name: 'Eredivisie', aliases: ['eredivisie', 'dutch eredivisie'] },
  { sport: 'soccer', league: 'por.1', name: 'Primeira Liga', aliases: ['primeira liga', 'liga portugal', 'portuguese primeira liga'] },
  { sport: 'soccer', league: 'uefa.champions', name: 'UEFA Champions League', aliases: ['champions league', 'ucl', 'uefa champions league'] },
  { sport: 'soccer', league: 'uefa.europa', name: 'UEFA Europa League', aliases: ['europa league', 'uel', 'uefa europa league'] },
  { sport: 'soccer', league: 'usa.1', name: 'MLS', aliases: ['mls', 'major league soccer', 'american major league soccer'] },
  { sport: 'soccer', league: 'ind.1', name: 'Indian Super League', aliases: ['indian super league', 'isl'] },
  { sport: 'soccer', league: 'fifa.world', name: 'FIFA World Cup', aliases: ['world cup', 'fifa world cup'] },
  { sport: 'basketball', league: 'nba', name: 'NBA', aliases: ['nba', 'national basketball association'] },
  { sport: 'basketball', league: 'wnba', name: 'WNBA', aliases: ['wnba'] },
  { sport: 'basketball', league: 'mens-college-basketball', name: 'NCAA Men\'s Basketball', aliases: ['college basketball', 'ncaab', 'ncaa basketball', 'march madness'] },
  { sport: 'football', league: 'nfl', name: 'NFL', aliases: ['nfl', 'national football league'] },
  { sport: 'football', league: 'college-football', name: 'College Football', aliases: ['college football', 'ncaaf', 'cfb', 'ncaa football'] },
  { sport: 'baseball', league: 'mlb', name: 'MLB', aliases: ['mlb', 'major league baseball'] },
  { sport: 'hockey', league: 'nhl', name: 'NHL', aliases: ['nhl', 'national hockey league'] },
  { sport: 'cricket', league: '8048', name: 'Indian Premier League', aliases: ['ipl', 'indian premier league'] },
  { sport: 'cricket', league: '8679', name: 'Pakistan Super League', aliases: ['psl', 'pakistan super league'] },
  { sport: 'cricket', league: '8044', name: 'Big Bash League', aliases: ['bbl', 'big bash', 'big bash league'] },
  { sport: 'cricket', league: '8653', name: 'Bangladesh Premier League', aliases: ['bpl', 'bangladesh premier league'] },
  { sport: 'cricket', league: '8604', name: 'ICC Men\'s T20 World Cup', aliases: ['t20 world cup', 'icc t20 world cup', 'icc mens t20 world cup', 'icc men\'s t20 world cup'] },
  { sport: 'cricket', league: '8053', name: 'T20 Blast', aliases: ['t20 blast', 'vitality blast', 'twenty20 cup'] },
  { sport: 'cricket', league: '8052', name: 'County Championship', aliases: ['county championship'] },
  { sport: 'cricket', league: '8050', name: 'Ranji Trophy', aliases: ['ranji trophy'] },
  { sport: 'cricket', league: '8043', name: 'Sheffield Shield', aliases: ['sheffield shield'] },
];

/** What a bare sport means when no league is named. */
const SPORT_DEFAULT: Record<string, string> = {
  soccer: 'eng.1',
  basketball: 'nba',
  football: 'nfl',
  'american football': 'nfl',
  baseball: 'mlb',
  hockey: 'nhl',
  'ice hockey': 'nhl',
};

const SPORT_NAMES: Record<string, string> = {
  soccer: 'soccer', 'association football': 'soccer',
  football: 'football', 'american football': 'football', 'american-football': 'football',
  basketball: 'basketball', baseball: 'baseball', hockey: 'hockey', 'ice hockey': 'hockey', 'ice-hockey': 'hockey',
  cricket: 'cricket',
};

const INDIVIDUAL = /^(tennis|golf|racing|f1|formula ?1|formula one|motorsport|mma|ufc|boxing|cycling|athletics)$/i;

const norm = (s: string): string => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9.' ]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * The ESPN league a request means, or undefined when it names none.
 *
 * Accepts a friendly name ("Premier League", "IPL"), an ESPN path
 * ("soccer/eng.1"), or a bare ESPN league id with its sport ("eng.1" with
 * sport "soccer") — the last so a league not in the table still works.
 */
export function resolveLeague(sportIn?: string, leagueIn?: string): League | undefined {
  const sport = sportIn ? SPORT_NAMES[norm(sportIn)] ?? norm(sportIn) : undefined;
  const raw = leagueIn?.trim();
  if (raw) {
    const n = norm(raw);
    const path = /^([a-z-]+)\/([a-z0-9.-]+)$/i.exec(raw);
    if (path) {
      const known = LEAGUES.find(l => l.sport === path[1]!.toLowerCase() && l.league === path[2]!.toLowerCase());
      return known ?? { sport: path[1]!.toLowerCase(), league: path[2]!.toLowerCase(), name: path[2]!, aliases: [] };
    }
    const candidates = sport ? LEAGUES.filter(l => l.sport === sport) : LEAGUES;
    const hit = candidates.find(l => l.league === n || l.aliases.includes(n) || norm(l.name) === n)
      ?? LEAGUES.find(l => l.league === n || l.aliases.includes(n) || norm(l.name) === n);
    if (hit) return hit;
    if (sport && /^[a-z0-9.-]+$/.test(n) && !n.includes(' ')) return { sport, league: n, name: raw, aliases: [] };
    return undefined;
  }
  if (sport) {
    const byAlias = LEAGUES.find(l => l.aliases.includes(norm(sportIn!)) || l.league === norm(sportIn!));
    if (byAlias) return byAlias; // "nba", "ipl" passed as the sport
    const def = SPORT_DEFAULT[sport];
    if (def) return LEAGUES.find(l => l.sport === (sport === 'american football' ? 'football' : sport) && l.league === def);
  }
  return undefined;
}

/** A league named by TheSportsDB ("English Premier League"), mapped to ESPN if it is one we know. */
function leagueFromName(name: string | undefined): League | undefined {
  if (!name) return undefined;
  const n = norm(name);
  return LEAGUES.find(l => l.aliases.includes(n) || norm(l.name) === n);
}

// ── Dates ───────────────────────────────────────────────────────────

const ymd = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** "today" / "yesterday" / "tomorrow" / YYYY-MM-DD → YYYY-MM-DD, in this machine's calendar. */
export function resolveDate(input: string | undefined, now: Date = new Date()): string {
  const t = (input ?? 'today').trim().toLowerCase();
  const shift = (days: number): string => { const d = new Date(now); d.setDate(d.getDate() + days); return ymd(d); };
  if (!t || t === 'today' || t === 'now' || t === 'live') return shift(0);
  if (t === 'yesterday') return shift(-1);
  if (t === 'tomorrow') return shift(1);
  const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(t);
  if (!m) throw new Error(`date must be YYYY-MM-DD, "today", "yesterday" or "tomorrow" — not "${input}".`);
  return `${m[1]}-${m[2]}-${m[3]}`;
}

// ── The block ───────────────────────────────────────────────────────

export type GameStatus = 'scheduled' | 'live' | 'final' | 'postponed';

export interface SideOut {
  name: string;
  short?: string;
  logo?: string;
  score?: string;
  record?: string;
  winner?: boolean;
}

export interface GameOut {
  id?: string;
  status: GameStatus;
  clock?: string;
  start?: string;
  venue?: string;
  home: SideOut;
  away: SideOut;
  note?: string;
  url?: string;
}

export interface StandingsOut {
  columns: string[];
  groups: Array<{ name: string; rows: Array<{ team: string; logo?: string; values: Array<string | number> }> }>;
}

type J = Record<string, any>; // ESPN's JSON is undocumented; every read below is guarded.

const httpsOnly = (u: unknown): string | undefined => (typeof u === 'string' && /^https:\/\/\S+$/.test(u) ? u : undefined);

function iso(v: unknown): string | undefined {
  if (typeof v !== 'string' || !v) return undefined;
  // ESPN writes "2026-09-20T13:00Z"; TheSportsDB "2026-02-21T13:30:00" (UTC, no zone).
  const text = /[zZ]|[+-]\d{2}:?\d{2}$/.test(v) ? v : `${v}Z`;
  const t = Date.parse(text);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

function scoreText(v: unknown): string | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (v && typeof v === 'object') return scoreText((v as J).displayValue ?? (v as J).value);
  return undefined;
}

const SUSPENDED = /POSTPONED|CANCEL|SUSPENDED|DELAYED|ABANDONED|FORFEIT/i;

/** ESPN's status → the card's four states, plus the words to show beside it. */
export function espnStatus(st: J | undefined): { status: GameStatus; clock?: string } {
  const type: J = st?.type ?? {};
  const name = String(type.name ?? '');
  const detail = String(type.shortDetail ?? type.detail ?? '').trim();
  const description = String(type.description ?? '').trim();
  if (SUSPENDED.test(name) || SUSPENDED.test(description)) return { status: 'postponed', clock: description || detail || undefined };
  if (type.state === 'in') {
    return { status: 'live', clock: detail || (st?.displayClock ? String(st.displayClock) : undefined) };
  }
  if (type.state === 'post' || type.completed === true) {
    // "Final/OT", "AET", "FT-Pens" say something; "FT" and "Final" do not.
    return { status: 'final', ...(detail && !/^(ft|final|full time|result)$/i.test(detail) ? { clock: detail } : {}) };
  }
  return { status: 'scheduled' };
}

function espnSide(c: J, status: GameStatus, sport: string): SideOut {
  const t: J = c.team ?? c.athlete ?? {};
  const name = String(t.displayName ?? t.name ?? t.shortDisplayName ?? 'TBD');
  const logo = httpsOnly(t.logo) ?? httpsOnly(t.logos?.[0]?.href);
  let score = status === 'scheduled' ? undefined : scoreText(c.score);
  let record: string | undefined = typeof c.records?.[0]?.summary === 'string' ? c.records[0].summary : undefined;
  if (sport === 'cricket' && score) {
    // "161/5 (18/20 ov, target 156)" — the runs are the score, the overs its detail.
    const m = /^(.*?)\s*\((.*)\)\s*$/.exec(score);
    if (m) { score = m[1] || undefined; record = m[2]; }
  }
  const winner = status === 'final' && (c.winner === true || c.winner === 'true');
  return {
    name,
    ...(t.abbreviation ? { short: String(t.abbreviation) } : {}),
    ...(logo ? { logo } : {}),
    ...(score !== undefined ? { score } : {}),
    ...(record ? { record } : {}),
    ...(winner ? { winner: true } : {}),
  };
}

/** One ESPN event → one game, or undefined when it is not two sides (a race, a golf round). */
export function espnGame(ev: J, sport: string): GameOut | undefined {
  const comp: J = ev?.competitions?.[0] ?? {};
  const sides: J[] = Array.isArray(comp.competitors) ? comp.competitors : [];
  if (sides.length !== 2) return undefined;
  const home = sides.find(s => s.homeAway === 'home') ?? sides[0]!;
  const away = sides.find(s => s !== home) ?? sides[1]!;
  const { status, clock } = espnStatus(comp.status ?? ev.status);
  const summary = typeof (comp.status ?? ev.status)?.summary === 'string' ? (comp.status ?? ev.status).summary : undefined;
  const headline = comp.notes?.find?.((n: J) => typeof n?.headline === 'string')?.headline as string | undefined;
  const url = httpsOnly((ev.links as J[] | undefined)?.find(l => httpsOnly(l?.href))?.href);
  const venue = typeof comp.venue?.fullName === 'string' ? comp.venue.fullName : undefined;
  const note = [headline, summary].filter(Boolean).join(' · ');
  const start = iso(ev.date ?? comp.date);
  return {
    ...(ev.id ? { id: String(ev.id) } : {}),
    status,
    ...(clock ? { clock } : {}),
    ...(start ? { start } : {}),
    ...(venue ? { venue } : {}),
    home: espnSide(home, status, sport),
    away: espnSide(away, status, sport),
    ...(note ? { note } : {}),
    ...(url ? { url } : {}),
  };
}

// ── Standings ───────────────────────────────────────────────────────

/** Columns per sport: a label and the ESPN stat names that may carry it, in preference order. */
const STANDING_COLUMNS: Record<string, Array<[string, string[]]>> = {
  soccer: [['GP', ['gamesPlayed']], ['W', ['wins']], ['D', ['ties']], ['L', ['losses']], ['GD', ['pointDifferential']], ['Pts', ['points']]],
  basketball: [['W', ['wins']], ['L', ['losses']], ['PCT', ['winPercent']], ['GB', ['gamesBehind']]],
  baseball: [['W', ['wins']], ['L', ['losses']], ['PCT', ['winPercent']], ['GB', ['gamesBehind']]],
  football: [['W', ['wins']], ['L', ['losses']], ['T', ['ties']], ['PCT', ['winPercent']]],
  hockey: [['GP', ['gamesPlayed']], ['W', ['wins']], ['L', ['losses']], ['OTL', ['otLosses', 'overtimeLosses']], ['PTS', ['points']]],
  cricket: [['M', ['matchesPlayed', 'gamesPlayed']], ['W', ['matchesWon', 'wins']], ['L', ['matchesLost', 'losses']], ['NR', ['noresult']], ['Pts', ['matchPoints', 'points']], ['NRR', ['netrr']]],
};

function stat(entry: J, names: string[]): { display?: string; value?: number } {
  const stats: J[] = Array.isArray(entry.stats) ? entry.stats : [];
  for (const n of names) {
    const s = stats.find(x => x?.name === n);
    if (s) return { display: s.displayValue !== undefined ? String(s.displayValue) : undefined, value: typeof s.value === 'number' ? s.value : undefined };
  }
  return {};
}

/** ESPN's standings tree → groups of rows, ordered the way the sport orders a table. */
export function espnStandings(doc: J, sport: string): StandingsOut {
  const cols = STANDING_COLUMNS[sport] ?? STANDING_COLUMNS.basketball!;
  const groups: StandingsOut['groups'] = [];
  const walk = (node: J, fallback: string): void => {
    if (Array.isArray(node?.standings?.entries)) {
      const entries: J[] = node.standings.entries;
      const ranked = entries.every(e => stat(e, ['rank']).value !== undefined && stat(e, ['rank']).value! > 0);
      const order = (e: J): number => {
        if (ranked) return stat(e, ['rank']).value!;
        if (sport === 'hockey' || sport === 'soccer') return -(stat(e, ['points']).value ?? 0);
        return -(stat(e, ['winPercent']).value ?? 0);
      };
      const rows = [...entries].sort((a, b) => order(a) - order(b)).map(e => {
        const logo = httpsOnly(e.team?.logos?.[0]?.href) ?? httpsOnly(e.team?.logo);
        return {
          team: String(e.team?.displayName ?? e.team?.name ?? '?'),
          ...(logo ? { logo } : {}),
          values: cols.map(([, names]) => stat(e, names).display ?? '–'),
        };
      });
      groups.push({ name: String(node.name || fallback), rows });
    }
    for (const child of Array.isArray(node?.children) ? node.children : []) walk(child, String(node?.name ?? fallback));
  };
  walk(doc, String(doc?.name ?? 'Standings'));
  return { columns: cols.map(([label]) => label), groups };
}

// ── TheSportsDB ─────────────────────────────────────────────────────

interface TsdbTeam { idTeam: string; strTeam: string; strSport?: string; strLeague?: string; strBadge?: string; strTeamBadge?: string }

/** A TheSportsDB event → one game. `now` decides whether an unmarked event is past or future. */
export function tsdbGame(e: J, now: Date = new Date()): GameOut {
  const start = iso(e.strTimestamp) ?? iso(e.dateEvent ? `${e.dateEvent}T${e.strTime || '00:00:00'}` : undefined);
  const st = String(e.strStatus ?? '').trim();
  const hs = scoreText(e.intHomeScore);
  const as = scoreText(e.intAwayScore);
  let status: GameStatus;
  if (e.strPostponed === 'yes' || SUSPENDED.test(st)) status = 'postponed';
  else if (/^(ns|not started|tbd|scheduled)$/i.test(st)) status = 'scheduled';
  else if (/^(ft|aet|pen|aot|match finished|finished|ended|final|after over ?time)$/i.test(st)) status = 'final';
  else if (/^(1h|2h|ht|et|bt|p|live|in progress|innings break|q[1-4]|ot)$/i.test(st)) status = 'live';
  else status = start && Date.parse(start) > now.getTime() ? 'scheduled' : 'final';
  const clean = (n: unknown): string => String(n ?? 'TBD').replace(/\s+Cricket$/i, '');
  const side = (name: unknown, badge: unknown, score: string | undefined, won: boolean): SideOut => {
    const logo = httpsOnly(badge);
    return {
      name: clean(name),
      ...(logo ? { logo } : {}),
      ...(status !== 'scheduled' && score !== undefined ? { score } : {}),
      ...(won ? { winner: true } : {}),
    };
  };
  const hn = Number(hs), an = Number(as);
  const decided = status === 'final' && hs !== undefined && as !== undefined && Number.isFinite(hn) && Number.isFinite(an) && hn !== an;
  const note = [e.strLeague, e.strResult].filter((x: unknown) => typeof x === 'string' && x.trim()).join(' · ');
  return {
    ...(e.idEvent ? { id: String(e.idEvent), url: `https://www.thesportsdb.com/event/${encodeURIComponent(String(e.idEvent))}` } : {}),
    status,
    ...(status === 'live' && st ? { clock: st } : {}),
    ...(start ? { start } : {}),
    ...(e.strVenue ? { venue: [e.strVenue, e.strCity].filter(Boolean).join(', ') } : {}),
    home: side(e.strHomeTeam, e.strHomeTeamBadge, hs, decided && hn > an),
    away: side(e.strAwayTeam, e.strAwayTeamBadge, as, decided && an > hn),
    ...(note ? { note } : {}),
  };
}

async function tsdbTeam(name: string, sport: string | undefined): Promise<TsdbTeam | undefined> {
  const search = async (q: string): Promise<TsdbTeam[]> => {
    const r = await cachedJson<{ teams?: TsdbTeam[] | null }>(slowCache, `${TSDB}/searchteams.php?t=${encodeURIComponent(q)}`, 'TheSportsDB team search');
    return r.value.teams ?? [];
  };
  const want = sport ? (sport === 'football' ? /^american football$/i : sport === 'hockey' ? /^ice hockey$/i : new RegExp(`^${sport}$`, 'i')) : undefined;
  let teams = await search(name);
  let hit = want ? teams.find(t => want.test(t.strSport ?? '')) : teams[0];
  // National sides are filed by sport: "Pakistan" is the football team, "Pakistan Cricket" the cricket one.
  if (!hit && sport && !new RegExp(`${sport}$`, 'i').test(name)) {
    teams = await search(`${name} ${sport === 'hockey' ? 'Hockey' : sport[0]!.toUpperCase() + sport.slice(1)}`);
    hit = want ? teams.find(t => want.test(t.strSport ?? '')) : teams[0];
  }
  return hit;
}

// ── ESPN teams ──────────────────────────────────────────────────────

interface EspnTeam { id: string; names: string[]; displayName: string }

async function espnTeam(lg: League, name: string): Promise<EspnTeam | undefined> {
  const r = await cachedJson<J>(teamListCache, `${ESPN}/${lg.sport}/${lg.league}/teams?limit=1000`, `ESPN ${lg.name} teams`);
  const list: J[] = (r.value?.sports?.[0]?.leagues?.[0]?.teams ?? []).map((x: J) => x.team).filter(Boolean);
  const teams: EspnTeam[] = list.map(t => ({
    id: String(t.id),
    displayName: String(t.displayName ?? t.name),
    names: [t.displayName, t.shortDisplayName, t.name, t.location, t.nickname, t.abbreviation]
      .filter((s): s is string => typeof s === 'string').map(norm),
  }));
  const n = norm(name);
  return teams.find(t => t.names.includes(n))
    ?? teams.find(t => t.names.some(x => x.startsWith(n) || (n.startsWith(x) && x.length > 3)))
    ?? teams.find(t => t.names.some(x => x.includes(n)));
}

function involves(g: GameOut, team: string): boolean {
  const n = norm(team);
  return [g.home, g.away].some(s => [s.name, s.short].some(v => v && (norm(v) === n || norm(v).includes(n))));
}

// ── The tool ────────────────────────────────────────────────────────

const STATUS_WORD: Record<GameStatus, string> = { scheduled: 'Scheduled', live: 'LIVE', final: 'Final', postponed: 'Postponed' };

function gameLine(g: GameOut, sport: string): string {
  const score = (s: SideOut): string => (s.score !== undefined ? ` ${s.score}` : '');
  // Soccer and cricket read home first; the American sports read "away at home".
  const pair = sport === 'soccer' || sport === 'cricket'
    ? `${g.home.name}${score(g.home)} v ${g.away.name}${score(g.away)}`
    : `${g.away.name}${score(g.away)} at ${g.home.name}${score(g.home)}`;
  const when = g.status === 'scheduled' && g.start ? ` — starts ${g.start.replace('.000Z', 'Z')}` : '';
  const clock = g.clock ? ` (${g.clock})` : '';
  const note = g.note ? ` — ${g.note}` : '';
  return `- ${STATUS_WORD[g.status]}${clock}: ${pair}${when}${note}`;
}

const HONESTY = 'Scores come from a public feed that is near-live but not guaranteed: a match in progress may already have moved on. '
  + 'Say where the scores came from and when (source, updatedAt). Never add or change a score from memory.';

export async function sportsScores(input: SportsInput, opts: SportsOptions = {}): Promise<string> {
  const now = opts.now ?? new Date();
  const kind = input.kind === 'standings' ? 'standings' : 'scores';
  const sportWord = input.sport?.trim();
  if (sportWord && INDIVIDUAL.test(sportWord)) {
    throw new Error(`SportsScores draws team games and league tables; ${sportWord} is an individual sport (races, tournaments). Use WebSearch for it.`);
  }
  const team = input.team?.trim() || undefined;
  let lg = resolveLeague(sportWord, input.league);
  if (input.league?.trim() && !lg) {
    const known = LEAGUES.map(l => l.name).join(', ');
    throw new Error(`Unknown league "${input.league}". Known: ${known}. Or pass an ESPN path such as "soccer/eng.1", or a team name.`);
  }
  const sportNorm = sportWord ? SPORT_NAMES[norm(sportWord)] : undefined;
  if (!lg && !team) {
    throw new Error(sportNorm === 'cricket'
      ? 'For cricket, name a league (IPL, PSL, Big Bash, T20 World Cup…) or a team ("Pakistan").'
      : 'SportsScores needs a league ("Premier League", "NBA"), a sport ("baseball"), or a team.');
  }

  if (kind === 'standings') {
    if (!lg && team) {
      const t = await tsdbTeam(team, sportNorm);
      lg = leagueFromName(t?.strLeague);
      if (!lg) throw new Error(`Standings need a league ESPN carries; could not place "${team}" in one${t?.strLeague ? ` (TheSportsDB files it under ${t.strLeague})` : ''}. Name the league.`);
    }
    return standings(lg!);
  }

  const date = resolveDate(input.date, now);
  if (!team) return scoreboard(lg!, date);

  // A league the caller named is trusted. Otherwise — a bare team, or a sport
  // whose default league may not be the team's ("soccer" + "Real Madrid") —
  // TheSportsDB says which league the team is in. Cricket teams stay with
  // TheSportsDB: ESPN's cricket scoreboards list one match per league.
  const named = Boolean(input.league?.trim()) || Boolean(sportWord && LEAGUES.some(l => l.aliases.includes(norm(sportWord)) || l.league === norm(sportWord)));
  if (named && lg && lg.sport !== 'cricket') return teamScores(lg, team, date, now);
  let t: TsdbTeam | undefined;
  try {
    t = await tsdbTeam(team, sportNorm ?? lg?.sport);
  } catch (err) {
    if (lg && lg.sport !== 'cricket') return teamScores(lg, team, date, now);
    throw err;
  }
  const mapped = t ? leagueFromName(t.strLeague) : undefined;
  if (t && mapped && mapped.sport !== 'cricket') return teamScores(mapped, t.strTeam, date, now);
  if (t) return tsdbScores(t, now);
  if (lg && lg.sport !== 'cricket') return teamScores(lg, team, date, now);
  throw new Error(`Could not find a team called "${team}"${sportNorm ? ` in ${sportNorm}` : ''} on TheSportsDB. Try its full name, or name the league.`);
}

async function scoreboard(lg: League, date: string): Promise<string> {
  const url = `${ESPN}/${lg.sport}/${lg.league}/scoreboard?dates=${date.replace(/-/g, '')}`;
  const r = await cachedJson<J>(scoreboardCache, url, `ESPN ${lg.name} scoreboard`);
  const leagueName = String(r.value?.leagues?.[0]?.name ?? lg.name);
  const events: J[] = Array.isArray(r.value?.events) ? r.value.events : [];
  let games = events.map(e => espnGame(e, lg.sport)).filter((g): g is GameOut => Boolean(g));
  if (events.length > 0 && games.length === 0) {
    throw new Error(`ESPN's ${leagueName} scoreboard lists events, but not head-to-head games (a race or tournament) — SportsScores draws team games only. Use WebSearch.`);
  }
  const notes: string[] = [];
  let shownDate = date;
  let at = r.at;

  if (games.length === 0) {
    // Nothing that day. ESPN's undated scoreboard is its own idea of the
    // nearest matchday, and the calendar says when the next one is.
    const calendar: unknown[] = Array.isArray(r.value?.leagues?.[0]?.calendar) ? r.value.leagues[0].calendar : [];
    const days = calendar.filter((c): c is string => typeof c === 'string').map(c => c.slice(0, 10)).sort();
    const next = days.find(d => d > date);
    const prev = [...days].reverse().find(d => d < date);
    notes.push(`No ${leagueName} games on ${date}.${prev ? ` The previous matchday was ${prev}.` : ''}${next ? ` The next is ${next}.` : ''}`);
    const near = await cachedJson<J>(scoreboardCache, `${ESPN}/${lg.sport}/${lg.league}/scoreboard`, `ESPN ${lg.name} scoreboard`);
    const nearGames = (Array.isArray(near.value?.events) ? near.value.events : []).map((e: J) => espnGame(e, lg.sport)).filter(Boolean) as GameOut[];
    if (nearGames.length > 0) {
      shownDate = String(near.value?.day?.date ?? nearGames[0]!.start?.slice(0, 10) ?? date);
      games = nearGames;
      at = near.at;
      notes.push(`Showing ESPN's nearest matchday instead: ${shownDate}.`);
    }
  }
  if (games.length === 0) {
    return `${notes[0] ?? `No ${leagueName} games on ${date}.`}\n(Source: ESPN, checked ${at}.)`;
  }
  return render({ title: leagueName, league: leagueName, sport: lg.sport, date: shownDate, games, source: 'ESPN', updatedAt: at }, notes);
}

async function teamScores(lg: League, team: string, date: string, now: Date): Promise<string> {
  const t = await espnTeam(lg, team);
  if (!t) throw new Error(`No team called "${team}" in ESPN's ${lg.name} list. Check the name, or name another league.`);
  // Playing on the day asked? Then the scoreboard, which is the fresher of the two.
  const day = await cachedJson<J>(scoreboardCache, `${ESPN}/${lg.sport}/${lg.league}/scoreboard?dates=${date.replace(/-/g, '')}`, `ESPN ${lg.name} scoreboard`);
  const todays = (Array.isArray(day.value?.events) ? day.value.events : []).map((e: J) => espnGame(e, lg.sport))
    .filter((g: GameOut | undefined): g is GameOut => Boolean(g) && involves(g!, t.displayName));
  if (todays.length > 0) {
    return render({ title: `${t.displayName} — ${lg.name}`, league: lg.name, sport: lg.sport, date, games: todays, source: 'ESPN', updatedAt: day.at }, []);
  }
  const base = `${ESPN}/${lg.sport}/${lg.league}/teams/${t.id}/schedule`;
  const results = await cachedJson<J>(slowCache, base, `ESPN ${t.displayName} schedule`);
  const lists: J[][] = [results.value?.events ?? []];
  // Soccer schedules list results only; fixtures are a second ask.
  if (lg.sport === 'soccer') {
    try { lists.push((await cachedJson<J>(slowCache, `${base}?fixture=true`, `ESPN ${t.displayName} fixtures`)).value?.events ?? []); } catch { /* results alone */ }
  }
  const seen = new Set<string>();
  const games = lists.flat().map(e => espnGame(e, lg.sport)).filter((g): g is GameOut => {
    if (!g || (g.id && seen.has(g.id))) return false;
    if (g.id) seen.add(g.id);
    return true;
  }).sort((a, b) => (a.start ?? '').localeCompare(b.start ?? ''));
  const upcoming = (g: GameOut): boolean => g.status === 'scheduled' || (g.status === 'postponed' && Boolean(g.start) && Date.parse(g.start!) > now.getTime());
  const past = games.filter(g => !upcoming(g)).slice(-3);
  const future = games.filter(upcoming).slice(0, 2);
  const shown = [...past, ...future];
  if (shown.length === 0) return `ESPN has no recent or upcoming ${lg.name} games for ${t.displayName}. (Source: ESPN, checked ${results.at}.)`;
  return render({
    title: `${t.displayName} — last and next games`, league: lg.name, sport: lg.sport, games: shown, source: 'ESPN', updatedAt: results.at,
  }, [`${t.displayName} has no ${lg.name} game on ${date}; these are its latest results and next fixtures.`]);
}

async function tsdbScores(t: TsdbTeam, now: Date): Promise<string> {
  const last = await cachedJson<{ results?: J[] | null }>(slowCache, `${TSDB}/eventslast.php?id=${encodeURIComponent(t.idTeam)}`, 'TheSportsDB last events');
  let next: Cached<{ events?: J[] | null }> | undefined;
  try { next = await cachedJson<{ events?: J[] | null }>(slowCache, `${TSDB}/eventsnext.php?id=${encodeURIComponent(t.idTeam)}`, 'TheSportsDB next events'); } catch { /* past alone */ }
  const past = (last.value.results ?? []).map(e => tsdbGame(e, now));
  const future = (next?.value.events ?? []).map(e => tsdbGame(e, now));
  const games = [...past.sort((a, b) => (a.start ?? '').localeCompare(b.start ?? '')), ...future.sort((a, b) => (a.start ?? '').localeCompare(b.start ?? ''))];
  const name = t.strTeam.replace(/\s+Cricket$/i, '');
  const sport = (t.strSport ?? '').toLowerCase() === 'soccer' ? 'soccer' : (t.strSport ?? '').toLowerCase();
  const notes = [
    'TheSportsDB\'s free tier returns only the most recent result and a few fixtures, and updates less often than a live scoreboard. '
      + 'For ball-by-ball or minute-by-minute scores, say so and suggest the league\'s own site.',
    ...(future.length === 0 ? ['No upcoming fixtures were listed.'] : []),
  ];
  if (games.length === 0) return `TheSportsDB lists no recent or upcoming events for ${name}. (Checked ${last.at}.)`;
  // No block-level league: a team's TheSportsDB league ("One Day International
  // Series") is often not the competition its last game was in; each game's
  // note names its own.
  return render({ title: `${name} — last and next games`, sport: sport || undefined, games, source: 'TheSportsDB', updatedAt: last.at }, notes);
}

async function standings(lg: League): Promise<string> {
  const r = await cachedJson<J>(slowCache, `${ESPN_STANDINGS}/${lg.sport}/${lg.league}/standings`, `ESPN ${lg.name} standings`);
  const table = espnStandings(r.value, lg.sport);
  const rows = table.groups.reduce((n, g) => n + g.rows.length, 0);
  if (rows === 0) throw new Error(`ESPN has no ${lg.name} standings to show (off-season, or a knockout competition).`);
  const leagueName = String(r.value?.name ?? lg.name);
  const lines = table.groups.flatMap(g => [
    ...(table.groups.length > 1 ? [`${g.name}:`] : []),
    ...g.rows.slice(0, 20).map((row, i) => `${i + 1}. ${row.team} — ${table.columns.map((c, k) => `${c} ${row.values[k]}`).join(', ')}`),
  ]);
  const block = { title: `${leagueName} standings`, league: leagueName, sport: lg.sport, standings: table, source: 'ESPN', updatedAt: r.at };
  return [
    `${leagueName} standings, from ESPN (checked ${r.at}):`,
    ...lines,
    'Show the table by pasting this block as it is:',
    fencedBlock('sports', block),
  ].join('\n');
}

function render(block: { title: string; league?: string; sport?: string; date?: string; games: GameOut[]; source: string; updatedAt: string }, notes: string[]): string {
  const sport = block.sport ?? '';
  const live = block.games.filter(g => g.status === 'live').length;
  return [
    `${block.title}${block.date ? ` (${block.date})` : ''}, from ${block.source} — checked ${block.updatedAt}${live ? `, ${live} in progress` : ''}:`,
    ...notes,
    ...block.games.map(g => gameLine(g, sport)),
    'Start times are UTC; the card shows them in the reader\'s local time.',
    HONESTY,
    'Show the scoreboard by pasting this block as it is:',
    fencedBlock('sports', block),
  ].join('\n');
}

export const sportsScoresDefinition = {
  name: 'SportsScores',
  description:
    'Live and recent scores, fixtures and league tables — no key needed. ESPN\'s public scoreboard for soccer '
    + '(Premier League, La Liga, Serie A, Bundesliga, Ligue 1, Champions League, MLS…), NFL, NBA, WNBA, MLB, NHL, college '
    + 'sports and cricket leagues (IPL, PSL, Big Bash, T20 World Cup), with TheSportsDB for teams ESPN cannot place '
    + '(e.g. national cricket sides). Give a `league` or `sport` for a day\'s scoreboard, a `team` for its latest and next '
    + 'games, or kind "standings" for the table. Near-live, not guaranteed. Returns a summary and a ready-to-paste '
    + '```sports block that draws a scoreboard card. Team sports only — not tennis, golf or racing.',
  inputSchema: {
    type: 'object',
    properties: {
      sport: { type: 'string', description: 'soccer, football (American), basketball, baseball, hockey or cricket. Alone, it means that sport\'s main league (soccer → Premier League).' },
      league: { type: 'string', description: 'League name ("Premier League", "NBA", "IPL", "Champions League") or an ESPN path ("soccer/ger.1").' },
      team: { type: 'string', description: 'A team ("Arsenal", "Lakers", "Pakistan" with sport "cricket"). Narrows the scoreboard, or lists its last and next games.' },
      date: { type: 'string', description: 'YYYY-MM-DD, "today" (default), "yesterday" or "tomorrow".' },
      kind: { type: 'string', enum: ['scores', 'standings'], description: 'scores (default) or the league table.' },
    },
  },
};
