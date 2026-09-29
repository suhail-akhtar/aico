/**
 * Topics for browsing intelligence: a small bundled map from well-known sites
 * to what they are about, keyword rules for everything else (read from page
 * titles), and the words that say nothing about a topic (stop words, and the
 * words every site puts in its own titles).
 *
 * Deliberately a readable table rather than a model: a person can see why
 * github.com is "Programming", and a wrong entry is a one-line fix.
 *
 * @module desktop/electron/browser-learn-topics
 */

export const TOPICS = [
  'Programming', 'AI', 'Docs & reference', 'News', 'Shopping', 'Video', 'Social', 'Mail & chat', 'Work & productivity',
  'Finance', 'Travel', 'Learning', 'Music', 'Games', 'Sports', 'Food & recipes', 'Health', 'Design', 'Jobs & careers',
  'Home & DIY', 'Science', 'Search', 'Other',
] as const;
export type Topic = typeof TOPICS[number];

/** Registrable domain (or host) → topic. A subdomain inherits its parent's entry unless it has its own. */
const SITES: Record<string, Topic> = {
  'github.com': 'Programming', 'gitlab.com': 'Programming', 'bitbucket.org': 'Programming', 'codeberg.org': 'Programming',
  'stackoverflow.com': 'Programming', 'stackexchange.com': 'Programming', 'superuser.com': 'Programming', 'serverfault.com': 'Programming',
  'npmjs.com': 'Programming', 'pypi.org': 'Programming', 'crates.io': 'Programming', 'dev.to': 'Programming', 'hashnode.com': 'Programming',
  'news.ycombinator.com': 'Programming', 'codepen.io': 'Programming', 'jsfiddle.net': 'Programming', 'replit.com': 'Programming',
  'vercel.com': 'Programming', 'netlify.com': 'Programming', 'localhost': 'Programming', '127.0.0.1': 'Programming',
  'developer.mozilla.org': 'Docs & reference', 'docs.python.org': 'Docs & reference', 'learn.microsoft.com': 'Docs & reference',
  'devdocs.io': 'Docs & reference', 'readthedocs.io': 'Docs & reference', 'docs.rs': 'Docs & reference', 'pkg.go.dev': 'Docs & reference',
  'wikipedia.org': 'Docs & reference', 'wiktionary.org': 'Docs & reference', 'britannica.com': 'Docs & reference', 'w3schools.com': 'Docs & reference',
  'openai.com': 'AI', 'chatgpt.com': 'AI', 'anthropic.com': 'AI', 'claude.ai': 'AI', 'huggingface.co': 'AI', 'perplexity.ai': 'AI',
  'gemini.google.com': 'AI', 'deepseek.com': 'AI', 'mistral.ai': 'AI', 'arxiv.org': 'Science',
  'nytimes.com': 'News', 'bbc.co.uk': 'News', 'bbc.com': 'News', 'theguardian.com': 'News', 'reuters.com': 'News', 'apnews.com': 'News',
  'cnn.com': 'News', 'washingtonpost.com': 'News', 'wsj.com': 'News', 'ft.com': 'News', 'economist.com': 'News', 'bloomberg.com': 'Finance',
  'theverge.com': 'News', 'techcrunch.com': 'News', 'arstechnica.com': 'News', 'wired.com': 'News', 'aljazeera.com': 'News', 'news.google.com': 'News',
  'amazon.com': 'Shopping', 'amazon.co.uk': 'Shopping', 'amazon.de': 'Shopping', 'amazon.in': 'Shopping', 'ebay.com': 'Shopping', 'etsy.com': 'Shopping',
  'walmart.com': 'Shopping', 'target.com': 'Shopping', 'bestbuy.com': 'Shopping', 'ikea.com': 'Shopping', 'aliexpress.com': 'Shopping',
  'flipkart.com': 'Shopping', 'argos.co.uk': 'Shopping', 'costco.com': 'Shopping', 'newegg.com': 'Shopping', 'zalando.com': 'Shopping',
  'youtube.com': 'Video', 'vimeo.com': 'Video', 'netflix.com': 'Video', 'twitch.tv': 'Video', 'primevideo.com': 'Video', 'disneyplus.com': 'Video',
  'twitter.com': 'Social', 'x.com': 'Social', 'reddit.com': 'Social', 'facebook.com': 'Social', 'instagram.com': 'Social', 'linkedin.com': 'Social',
  'mastodon.social': 'Social', 'bsky.app': 'Social', 'threads.net': 'Social', 'tiktok.com': 'Social', 'pinterest.com': 'Social', 'quora.com': 'Social',
  'mail.google.com': 'Mail & chat', 'outlook.live.com': 'Mail & chat', 'outlook.office.com': 'Mail & chat', 'mail.proton.me': 'Mail & chat',
  'web.whatsapp.com': 'Mail & chat', 'app.slack.com': 'Mail & chat', 'discord.com': 'Mail & chat', 'teams.microsoft.com': 'Mail & chat',
  'web.telegram.org': 'Mail & chat', 'messenger.com': 'Mail & chat',
  'docs.google.com': 'Work & productivity', 'drive.google.com': 'Work & productivity', 'calendar.google.com': 'Work & productivity',
  'notion.so': 'Work & productivity', 'trello.com': 'Work & productivity', 'asana.com': 'Work & productivity', 'atlassian.net': 'Work & productivity',
  'office.com': 'Work & productivity', 'dropbox.com': 'Work & productivity', 'airtable.com': 'Work & productivity', 'miro.com': 'Work & productivity',
  'paypal.com': 'Finance', 'coinbase.com': 'Finance', 'investopedia.com': 'Finance', 'finance.yahoo.com': 'Finance', 'morningstar.com': 'Finance',
  'booking.com': 'Travel', 'airbnb.com': 'Travel', 'expedia.com': 'Travel', 'tripadvisor.com': 'Travel', 'skyscanner.net': 'Travel',
  'kayak.com': 'Travel', 'maps.google.com': 'Travel', 'google.com/travel': 'Travel',
  'coursera.org': 'Learning', 'udemy.com': 'Learning', 'khanacademy.org': 'Learning', 'edx.org': 'Learning', 'duolingo.com': 'Learning',
  'spotify.com': 'Music', 'soundcloud.com': 'Music', 'bandcamp.com': 'Music', 'music.apple.com': 'Music', 'music.youtube.com': 'Music',
  'steampowered.com': 'Games', 'store.steampowered.com': 'Games', 'epicgames.com': 'Games', 'ign.com': 'Games', 'itch.io': 'Games',
  'espn.com': 'Sports', 'bbc.co.uk/sport': 'Sports', 'skysports.com': 'Sports', 'nba.com': 'Sports', 'fifa.com': 'Sports', 'cricbuzz.com': 'Sports',
  'allrecipes.com': 'Food & recipes', 'bbcgoodfood.com': 'Food & recipes', 'seriouseats.com': 'Food & recipes', 'food.com': 'Food & recipes',
  'nhs.uk': 'Health', 'webmd.com': 'Health', 'mayoclinic.org': 'Health', 'healthline.com': 'Health',
  'figma.com': 'Design', 'dribbble.com': 'Design', 'behance.net': 'Design', 'canva.com': 'Design',
  'indeed.com': 'Jobs & careers', 'glassdoor.com': 'Jobs & careers', 'wellfound.com': 'Jobs & careers',
  'homedepot.com': 'Home & DIY', 'bunnings.com.au': 'Home & DIY', 'wayfair.com': 'Home & DIY',
  'nature.com': 'Science', 'sciencedirect.com': 'Science', 'nasa.gov': 'Science', 'scholar.google.com': 'Science',
  'google.com': 'Search', 'bing.com': 'Search', 'duckduckgo.com': 'Search', 'search.brave.com': 'Search', 'ecosia.org': 'Search',
};

/** Words in page titles that point at a topic, for sites the table does not know. First match wins. */
const KEYWORDS: Array<[RegExp, Topic]> = [
  [/\b(api|sdk|npm|typescript|javascript|python|rust|golang|java|kotlin|react|vue|svelte|node\.?js|docker|kubernetes|git|github|compiler|debug|bug|repo|function|class|css|html|sql|database|regex|linux|bash|powershell)\b/i, 'Programming'],
  [/\b(llm|gpt|claude|gemini|machine learning|neural|transformer|prompt|embedding|ai model|diffusion)\b/i, 'AI'],
  [/\b(docs?|documentation|reference|manual|guide|tutorial|how to)\b/i, 'Docs & reference'],
  [/\b(recipe|recipes|bake|baking|cook|cooking|ingredients?|dinner|lunch|breakfast)\b/i, 'Food & recipes'],
  [/\b(flight|flights|hotel|hotels|trip|travel|itinerary|airport|booking|vacation|holiday)\b/i, 'Travel'],
  [/\b(price|prices|deal|deals|buy|shop|sale|cart|review|reviews|vs\.?|best \d*|specs?)\b/i, 'Shopping'],
  [/\b(stock|stocks|invest|investing|etf|mortgage|loan|tax|taxes|budget|bank|crypto|bitcoin|savings)\b/i, 'Finance'],
  [/\b(job|jobs|career|hiring|salary|resume|cv|interview)\b/i, 'Jobs & careers'],
  [/\b(course|lesson|learn|learning|study|exam|university|lecture)\b/i, 'Learning'],
  [/\b(symptoms?|health|doctor|medicine|diet|fitness|workout|sleep)\b/i, 'Health'],
  [/\b(song|album|playlist|lyrics|band|concert)\b/i, 'Music'],
  [/\b(game|games|gaming|steam|playstation|xbox|nintendo)\b/i, 'Games'],
  [/\b(football|soccer|cricket|nba|nfl|tennis|f1|formula 1|match|score|league)\b/i, 'Sports'],
  [/\b(news|breaking|live updates|election|politics)\b/i, 'News'],
  [/\b(garden|diy|renovation|furniture|desk|chair|kitchen|paint|tools?)\b/i, 'Home & DIY'],
  [/\b(design|figma|typography|font|logo|ui|ux)\b/i, 'Design'],
];

/** A site's topic: its own entry, a parent domain's, or what its page titles say. */
export function topicOf(host: string, titles: string[] = []): Topic {
  const h = host.toLowerCase().replace(/^www\./, '');
  const parts = h.split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    const hit = SITES[parts.slice(i).join('.')];
    if (hit) return hit;
  }
  if (SITES[h]) return SITES[h]!;
  const text = titles.join(' ');
  for (const [re, topic] of KEYWORDS) if (re.test(text)) return topic;
  return 'Other';
}

/** Words that carry no topic. Short on purpose: TF-IDF already discounts what is everywhere. */
export const STOP = new Set((
  'a an and are as at be by for from has have how in is it its of on or that the this to was were what when where which who why will with ' +
  'you your yours our we us i me my mine he she they them their his her it’s i’m don’t can’t isn’t not no yes do does did done but if then than so ' +
  'about into over under up down out off more most less least very just also only all any some each every other such same own new old ' +
  'can could should would may might must shall one two three first last next best top vs versus via per get got use using used ' +
  'page pages home homepage official site website web online free login sign signin log account welcome search results result ' +
  'google bing duckduckgo youtube wikipedia amazon reddit github com www http https html htm php net org co uk io app ' +
  'news blog post article video watch channel view read review reviews guide 2023 2024 2025 2026 2027'
).split(/\s+/));
