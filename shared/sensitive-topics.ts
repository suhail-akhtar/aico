/**
 * What "About you" must never infer, decided in code (ADR 0018).
 *
 * A learner that builds a picture of a person from their work and browsing
 * can, without trying, conclude things nobody asked it to: a clinic visited
 * twice becomes "interested in oncology", a search for a prayer time becomes
 * a religion. Those inferences are the creepiness and harm the ADR rules out
 * — health, religion, politics, sexuality, ethnicity, finances, precise
 * location, family and relationships (plus dating and adult sites, which
 * imply the same) — and a prompt asking a model "please don't" is not an
 * enforcement. So every place a fact can enter passes through these checks:
 * the desktop's browsing digest (desktop/electron/browser-profile-digest.ts)
 * drops domains and terms before they are written, and the engine's learner
 * (src/profile/sensitive.ts) drops candidates *and* the model's phrasing of
 * them.
 *
 * Shared, because the two sides must agree on the list: one table here, read
 * by both. Deliberately over-blocking — a dropped "uses health checks" fact
 * costs nothing; a kept "has diabetes" costs trust. Word boundaries and a few
 * carve-outs (`health check`, `race condition` is not matched at all) keep
 * the common developer phrases from being dropped wholesale.
 *
 * Not here: anything that reads page contents, or any judgement by a model.
 *
 * @module shared/sensitive-topics
 */

export type SensitiveArea =
  | 'health' | 'religion' | 'politics' | 'sexuality' | 'ethnicity'
  | 'finances' | 'location' | 'family' | 'dating' | 'adult';

/** Words and phrases per area. Lower-case text is tested; `\b` keeps "json" from matching "son". */
const TERMS: ReadonlyArray<[SensitiveArea, RegExp]> = [
  ['health', /\b(health(?![-\s]?checks?\b)|healthcare|medical|medic(?:ine|ation)s?|symptoms?|diagnos\w*|diseases?|cancer|oncolog\w*|diabet\w*|depress(?:ion|ed)|anxiety|therap(?:y|ist|ies)|mental|psychiatr\w*|pregnan\w*|hiv|illness|surgery|hospital|clinic|clinics|doctor|doctors|nhs|pharmac\w*|adhd|autis\w*|disorder|disabilit\w*|diet|dieting|weight loss|fitness|workout|rehab|addiction|alcoholi\w*|vaccin\w*|covid)\b/],
  ['religion', /\b(religio\w*|church|churches|mosque|synagogue|temple|bible|quran|koran|torah|prayers?|praying|god|jesus|christ|christian\w*|allah|islam\w*|muslims?|hindu\w*|buddh\w*|jewish|judaism|sikh\w*|catholic\w*|protestant\w*|atheis\w*|ramadan|halal|kosher|sermon)\b/],
  ['politics', /\b(politic\w*|elections?|electoral|votes?|voting|voter|democrats?|democratic party|republicans?|labour party|tory|tories|conservative party|liberal democrats?|parliament\w*|congress\w*|senators?|senate|trump|biden|brexit|left-wing|right-wing|socialis\w*|communis\w*|fascis\w*|activis\w*|protests?)\b/],
  ['sexuality', /\b(sexual\w*|sex|gay|lesbian|bisexual|lgbt\w*|queer|transgender|nonbinary|non-binary|pride month)\b/],
  ['adult', /\b(porn\w*|nsfw|xxx|onlyfans|erotic\w*|fetish\w*|escort\w*|hentai)\b/],
  ['dating', /\b(dating|tinder|bumble|grindr|okcupid|hinge app|matchmaking)\b/],
  ['ethnicity', /\b(ethnic\w*|racial|racism|racist|nationality|immigra\w*|asylum|caste|ancestry)\b/],
  ['finances', /\b(banks?|banking|loans?|mortgages?|debts?|credit cards?|credit score|salary|salaries|income|taxes|tax return|invest\w*|stocks|crypto\w*|bitcoin|ethereum|savings|pension|insurance|payday|bankrupt\w*|net worth|wealth|forex|trading account)\b/],
  ['location', /\b(home address|street address|my address|postcode|post code|zip code|near me|directions to|gps|geolocat\w*|latitude|longitude|google maps|where i live)\b/],
  ['family', /\b(wife|husband|spouse|girlfriend|boyfriend|fianc\w*|married|marriage|divorc\w*|children|kids|my son|my daughter|my mother|my father|my mom|my dad|my partner|baby|babies|newborn|wedding|relationship advice|breakup)\b/],
];

/** Domains whose very visit says something sensitive. A subdomain inherits its parent's entry. */
const DOMAINS: Record<string, SensitiveArea> = {
  'webmd.com': 'health', 'nhs.uk': 'health', 'mayoclinic.org': 'health', 'healthline.com': 'health', 'medlineplus.gov': 'health',
  'drugs.com': 'health', 'patient.info': 'health', 'psychologytoday.com': 'health', 'betterhelp.com': 'health', 'zocdoc.com': 'health',
  'bible.com': 'religion', 'biblegateway.com': 'religion', 'quran.com': 'religion', 'islamicfinder.org': 'religion', 'chabad.org': 'religion',
  'tinder.com': 'dating', 'bumble.com': 'dating', 'hinge.co': 'dating', 'match.com': 'dating', 'okcupid.com': 'dating', 'grindr.com': 'dating',
  'pornhub.com': 'adult', 'xvideos.com': 'adult', 'xhamster.com': 'adult', 'onlyfans.com': 'adult',
  'paypal.com': 'finances', 'chase.com': 'finances', 'bankofamerica.com': 'finances', 'wellsfargo.com': 'finances', 'hsbc.co.uk': 'finances',
  'hsbc.com': 'finances', 'barclays.co.uk': 'finances', 'lloydsbank.com': 'finances', 'natwest.com': 'finances', 'monzo.com': 'finances',
  'revolut.com': 'finances', 'coinbase.com': 'finances', 'binance.com': 'finances', 'robinhood.com': 'finances', 'etrade.com': 'finances',
  'fidelity.com': 'finances', 'vanguard.com': 'finances', 'schwab.com': 'finances', 'creditkarma.com': 'finances', 'experian.com': 'finances',
  'finance.yahoo.com': 'finances', 'investopedia.com': 'finances', 'morningstar.com': 'finances', 'bloomberg.com': 'finances',
  'maps.google.com': 'location', 'maps.apple.com': 'location', 'openstreetmap.org': 'location', 'waze.com': 'location',
  'zillow.com': 'location', 'rightmove.co.uk': 'location', 'zoopla.co.uk': 'location',
  'ancestry.com': 'ethnicity', '23andme.com': 'health',
};

/** Pieces of a host name that are enough on their own ("mybank", "dating-site", "xxx"). */
const DOMAIN_PARTS: ReadonlyArray<[SensitiveArea, RegExp]> = [
  ['adult', /porn|xxx|sex|nsfw|escort|onlyfans|hentai/],
  ['dating', /dating|tinder|grindr/],
  ['finances', /bank|loan|mortgage|credit|crypto|invest|insurance|casino|betting/],
  ['health', /health|clinic|medic|pharma|hospital|therapy|doctor/],
  ['religion', /church|mosque|bible|quran|synagogue|prayer/],
  ['politics', /vote|election|politic|campaign/],
];

/** The sensitive area a piece of text touches, or undefined. */
export function sensitiveArea(text: string): SensitiveArea | undefined {
  const t = text.toLowerCase();
  for (const [area, re] of TERMS) if (re.test(t)) return area;
  return undefined;
}

/** The sensitive area a domain (or host) belongs to, or undefined. */
export function sensitiveDomain(host: string): SensitiveArea | undefined {
  const h = host.toLowerCase().replace(/^www\./, '');
  const parts = h.split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    const hit = DOMAINS[parts.slice(i).join('.')];
    if (hit) return hit;
  }
  // `google.com/maps` and the like are paths; the digest never keeps paths, so the host is all there is.
  if (/^maps\./.test(h)) return 'location';
  const labels = parts.slice(0, -1).join(' ');
  for (const [area, re] of DOMAIN_PARTS) if (re.test(labels)) return area;
  return sensitiveArea(labels.replace(/[-_]/g, ' '));
}
