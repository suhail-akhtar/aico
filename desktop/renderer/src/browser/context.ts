/**
 * What the copilot tells the agent about the page, and the quick actions.
 *
 * Every copilot message carries a short header naming the page the person is
 * looking at — never the page itself. The agent reads more with its
 * `browser_*` tools when it needs to, which keeps a long browsing chat cheap
 * and means the page is always read fresh rather than from a stale copy.
 *
 * The safety rules are part of the words here on purpose: the agent never
 * solves a human check, never types a password, card number, CVV or one-time
 * code, and never submits a payment — it hands the page to the person.
 *
 * Pure, so it is unit-tested without a DOM.
 *
 * @module desktop/renderer/browser/context
 */

export const CONTEXT_OPEN = '<browser-context>';
export const CONTEXT_CLOSE = '</browser-context>';

export interface PageContext {
  url: string;
  title: string;
  selection?: string;
  humanCheck?: boolean;
  loginWall?: boolean;
  paywall?: boolean;
  /** Other open tabs, for "compare with other tabs". */
  otherTabs?: Array<{ title: string; url: string }>;
}

const clip = (s: string, n: number): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** The header prepended to a copilot message. Short: the page is read with tools, not pasted. */
export function buildContextHeader(ctx: PageContext): string {
  const lines = [
    CONTEXT_OPEN,
    'The user is looking at this page in the AICO built-in browser (the tab your browser_* tools drive):',
    `URL: ${ctx.url}`,
    `Title: ${clip(ctx.title || '(untitled)', 160)}`,
  ];
  if (ctx.selection?.trim()) lines.push(`Selected text: "${clip(ctx.selection, 600)}"`);
  if (ctx.otherTabs?.length) {
    lines.push(`Other open tabs: ${ctx.otherTabs.slice(0, 8).map(t => `${clip(t.title || t.url, 60)} <${t.url}>`).join('; ')}`);
  }
  if (ctx.humanCheck) lines.push('A human check (CAPTCHA / "verify you are human") is on screen. Do not try to solve it: call browser_handoff and let the user do it.');
  if (ctx.loginWall) lines.push('The page wants a sign-in. Never type passwords or one-time codes: hand the page to the user with browser_handoff.');
  if (ctx.paywall) lines.push('The page appears to be behind a paywall.');
  lines.push('This header is not the page content. Read the page with browser_read (mode "reader"; fall back to browser_text) or browser_insights before answering about it.');
  lines.push(CONTEXT_CLOSE);
  return lines.join('\n');
}

export function withContext(message: string, ctx: PageContext | null): string {
  return ctx ? `${buildContextHeader(ctx)}\n\n${message}` : message;
}

/** The message as the person wrote it, without the header. */
export function stripContextHeader(text: string): string {
  const start = text.indexOf(CONTEXT_OPEN);
  if (start < 0) return text;
  const end = text.indexOf(CONTEXT_CLOSE, start);
  if (end < 0) return text;
  return (text.slice(0, start) + text.slice(end + CONTEXT_CLOSE.length)).replace(/^\s+/, '');
}

/** The page named in a message's header, for the "on <page>" line under it. */
export function contextPageOf(text: string): { url: string; title: string } | null {
  const start = text.indexOf(CONTEXT_OPEN);
  if (start < 0) return null;
  const block = text.slice(start, text.indexOf(CONTEXT_CLOSE, start));
  const url = block.match(/^URL: (.+)$/m)?.[1]?.trim();
  const title = block.match(/^Title: (.+)$/m)?.[1]?.trim();
  return url ? { url, title: title ?? url } : null;
}

export const SAFETY_RULES = 'Never type passwords, card numbers, CVV or one-time codes, never solve CAPTCHAs or "I am human" checks, and never submit a payment or an irreversible form without asking me first — for any of those, use browser_handoff and let me do it.';

export interface QuickAction {
  id: string;
  label: string;
  icon: string;
  /** Needs a real page (not the new tab page). */
  needsPage: boolean;
  prompt: string;
}

export const QUICK_ACTIONS: QuickAction[] = [
  {
    id: 'summarize', label: 'Summarize this page', icon: 'file-text', needsPage: true,
    prompt: 'Summarize this page. Read it first with browser_read in reader mode (fall back to browser_text if that tool is unavailable). Answer with a one-line gist, then short sections under headings, then "Key takeaways" as 3–6 bullets, and end with a "Source:" line naming the page title and URL. Do not pad; do not invent anything the page does not say.',
  },
  {
    id: 'keypoints', label: 'Key points', icon: 'list', needsPage: true,
    prompt: 'List the key points of this page as 5–8 tight bullets, most important first. Read it with browser_read (reader mode) first — fall back to browser_text. Quote numbers and names exactly as the page gives them. End with a "Source:" line.',
  },
  {
    id: 'explain', label: 'Explain simply', icon: 'sparkles', needsPage: true,
    prompt: 'Explain what this page is about in plain language, as if to a smart 12-year-old: what it is, why it matters, and any terms a newcomer would trip on (with one-line definitions). Read it with browser_read (reader mode) first. Keep it under 250 words.',
  },
  {
    id: 'tables', label: 'Extract tables', icon: 'table', needsPage: true,
    prompt: 'Extract the tabular data on this page. Use browser_read in "full" mode (or browser_text) to get the content, then give each table as a clean Markdown table with a short caption. If the data is better as a chart, add one. If there are no tables, say so and pull out any structured lists instead.',
  },
  {
    id: 'prices', label: 'Find prices & deals', icon: 'tag', needsPage: true,
    prompt: 'Find the prices, discounts, shipping costs and deals on this page. Read it with browser_read (full mode) or browser_text; scroll with browser_scroll if more loads below. Give a table of item, price, original price / discount, and conditions, then point out the best value. Do not add anything to a cart or buy anything.',
  },
  {
    id: 'form', label: 'Fill this form', icon: 'edit', needsPage: true,
    prompt: `Help me fill in the form on this page. First call browser_forms to see its fields (fall back to browser_snapshot). Tell me which fields you can fill from what you know about me and ask me for the rest, then fill them with browser_fill (or browser_type). Do NOT submit the form — show me what you filled and wait for me to confirm. ${SAFETY_RULES}`,
  },
  {
    id: 'compare', label: 'Compare with other tabs', icon: 'split', needsPage: true,
    prompt: 'Compare this page with the other open tabs listed in the browser context. Use browser_tabs to switch between them and browser_read to read each one, then give a comparison table of the things that matter (price, features, pros and cons, as fits), and a one-paragraph recommendation. Leave me on the tab I started from.',
  },
  {
    id: 'translate', label: 'Translate', icon: 'globe', needsPage: true,
    prompt: 'Translate the main content of this page into English (or, if it is already in English, ask me which language I want). Read it with browser_read in reader mode first. Keep headings and lists; give the translation only, then one line naming the source language.',
  },
  {
    id: 'whatcan', label: 'What can I do here?', icon: 'compass', needsPage: true,
    prompt: 'What can I do on this page? Use browser_insights (fall back to browser_snapshot) and tell me, briefly, what the page is for, the main actions available, anything that needs my attention (sign-in, cookie banner, paywall, human check), and 2–3 things you could do for me here.',
  },
];

/** Quick starts on the new tab page: prompts to begin with, finished by the person. */
export const QUICK_STARTS: Array<{ id: string; label: string; icon: string; prompt: string; hint: string }> = [
  { id: 'summarize', label: 'Summarize a page', icon: 'file-text', hint: 'Paste a link and get the gist', prompt: 'Open this page and summarize it with headings and key takeaways: ' },
  { id: 'research', label: 'Research a topic across sites', icon: 'search', hint: 'Several sources, one answer', prompt: 'Research this across several reliable sites — open and read at least 3 sources in the browser, then give me a sourced summary with a comparison where it helps: ' },
  { id: 'form', label: 'Fill a form for me', icon: 'edit', hint: 'You confirm before anything is sent', prompt: `Go to this page and fill in its form for me, asking me for anything you don't know. Do not submit until I confirm. ${SAFETY_RULES} The page: ` },
  { id: 'compare', label: 'Compare products', icon: 'split', hint: 'Prices, specs, reviews side by side', prompt: 'Compare these products — find each one, read the product pages, and give me a table of price, key specs and review scores, plus a recommendation: ' },
];

const VERBS: Record<string, [string, string, string]> = {
  // action: [doing, done, do]
  open: ['Opening', 'Opened', 'open'], navigate: ['Navigating', 'Navigated', 'navigate'], goto: ['Opening', 'Opened', 'open'],
  click: ['Clicking', 'Clicked', 'click'], type: ['Typing into', 'Typed into', 'type into'], fill: ['Filling', 'Filled', 'fill'],
  select: ['Choosing', 'Chose', 'choose'], press: ['Pressing', 'Pressed', 'press'], hover: ['Hovering over', 'Hovered over', 'hover over'],
  scroll: ['Scrolling', 'Scrolled', 'scroll'], wait: ['Waiting for', 'Waited for', 'wait for'], read: ['Reading', 'Read', 'read'],
  text: ['Reading', 'Read', 'read'], snapshot: ['Looking at', 'Looked at', 'look at'], insights: ['Looking over', 'Looked over', 'look over'],
  forms: ['Reading the forms on', 'Read the forms on', 'read the forms on'], screenshot: ['Taking a screenshot of', 'Took a screenshot of', 'take a screenshot of'],
  evaluate: ['Checking', 'Checked', 'check'], back: ['Going back', 'Went back', 'go back'], forward: ['Going forward', 'Went forward', 'go forward'],
  reload: ['Reloading', 'Reloaded', 'reload'], tabs: ['Switching tabs', 'Switched tabs', 'switch tabs'], handoff: ['Handing over to you', 'Handed over', 'hand over'],
  download: ['Downloading', 'Downloaded', 'download'], upload: ['Uploading', 'Uploaded', 'upload'],
};

/** "Clicking “Add to cart”" — what the agent is doing, for the status line. */
export function describeAgentAction(ev: { action: string; label?: string; status: string; detail?: string }): string {
  const key = ev.action.replace(/^browser_/, '').toLowerCase();
  const [now, past, base] = VERBS[key] ?? [key ? key[0]!.toUpperCase() + key.slice(1) : 'Working', key || 'Worked', key || 'do that'];
  const label = ev.label?.trim() ? clip(ev.label, 60) : '';
  const quoted = label ? (/^(https?:|www\.)/.test(label) || ['open', 'navigate', 'goto'].includes(key) ? label : `“${label}”`) : '';
  const bare = !quoted && ['read', 'text', 'snapshot', 'insights', 'forms', 'screenshot', 'evaluate', 'scroll', 'wait'].includes(key) ? 'the page' : '';
  const object = quoted || bare;
  if (ev.status === 'blocked') return `Stopped before ${now.toLowerCase()} ${object}`.trim() + (ev.detail ? ` — ${clip(ev.detail, 90)}` : '');
  if (ev.status === 'error') return `Couldn't ${base} ${object}`.trim() + (ev.detail ? ` — ${clip(ev.detail, 90)}` : '');
  if (ev.status === 'done') return `${past} ${object}`.trim();
  return `${now} ${object}`.trim() + '…';
}
