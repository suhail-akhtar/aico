
import { offerToolImage } from './tool-images.js';
import { guardedFetch } from '../canvas/deck-media.js';
import { guardPageText, stripHiddenHtml, withNotice, type HiddenSample } from '../../shared/injection-guard.js';

export interface WebFetchInput {
  url: string;
  max_length?: number;
}

/**
 * How WebFetch reaches the network: through the SSRF guard.
 *
 * WHY: WebFetch is read-only, offered in plan mode and needs no permission, and
 * it was a bare `fetch(url, { redirect: 'follow' })` — so a prompt-injected
 * page could have it read http://127.0.0.1:7340/api/…, the cloud metadata
 * endpoint, a LAN admin page, or any of those through a redirect or a decimal
 * / hex / IPv4-mapped spelling of the address (security review 2026-10). It
 * now goes through `guardedFetch`: http(s) only, public addresses only (every
 * resolved address judged), pinned to the checked address, every redirect hop
 * re-checked, a byte cap and a deadline. HttpRequest, with a credential the
 * owner bound to a host, is the tool for private addresses.
 */
type WebFetchTransport = (url: string) => Promise<Response>;

const MAX_PAGE_BYTES = 12 * 1024 * 1024 + 1;

const guardedTransport: WebFetchTransport = async (url) => {
  let res;
  try {
    res = await guardedFetch(url, { maxBytes: MAX_PAGE_BYTES, timeoutMs: 30_000, headers: { 'User-Agent': 'aico/1.0.0' } });
  } catch (err) {
    throw new Error(`WebFetch did not fetch ${url.slice(0, 200)}: ${err instanceof Error ? err.message : String(err)}. `
      + 'WebFetch reaches public http(s) addresses only.');
  }
  const headers = new Headers();
  for (const [k, v] of Object.entries(res.headers)) {
    if (v === undefined) continue;
    for (const one of Array.isArray(v) ? v : [v]) headers.append(k, one);
  }
  const nullBody = res.status === 204 || res.status === 304 || (res.status >= 100 && res.status < 200);
  return new Response(nullBody ? null : new Uint8Array(res.body), { status: res.status || 502, headers });
};

let transport: WebFetchTransport = guardedTransport;

/** Tests only: serve WebFetch from a local fixture server. Omit to restore the guard. */
export function setWebFetchTransportForTest(fn?: WebFetchTransport): void {
  transport = fn ?? guardedTransport;
}

export async function webFetch(input: WebFetchInput): Promise<string> {
  const maxLength = input.max_length ?? 5000;
  const response = await transport(input.url);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} for ${input.url}`);
  }

  const contentType = response.headers.get('content-type') ?? '';

  /*
    An image URL is a picture, not a page.

    Read as text it was a few kilobytes of mojibake cut at five thousand
    characters — the model could say nothing about it, and did not know why.
    Now it is offered the way a Read of the same file would be: shown to a
    model that can look, and described in plain words to one that cannot.
    SVG is excluded on purpose: it is XML, and the text is the useful form.
  */
  if (/^image\//i.test(contentType) && !/svg/i.test(contentType)) {
    return fetchedImage(input.url, contentType, response);
  }

  let text: string;
  // Prompt-injection guard (shared/injection-guard.ts): a page is data, never
  // instructions. Hidden elements go before the tags do, flagged passages are
  // wrapped, and the notice leads the result (outside the length cut).
  let hidden = 0; let tricks = 0; let samples: HiddenSample[] = [];

  if (contentType.includes('application/json')) {
    const json = await response.json();
    text = JSON.stringify(json, null, 2);
  } else {
    text = await response.text();
    // Strip HTML tags for readability
    if (contentType.includes('text/html')) {
      const stripped = stripHiddenHtml(text
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ''));
      hidden = stripped.removed; tricks = stripped.tricks; samples = stripped.samples;
      text = stripped.html
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
    }
  }

  if (text.length > maxLength) {
    text = text.slice(0, maxLength) + `\n\n[... truncated at ${maxLength} chars]`;
  }
  return withNotice(guardPageText(text, { hidden, tricks, hiddenSamples: samples }));
}

/**
 * Bytes WebFetch will download for an image before giving up on it.
 *
 * Above what a tool may attach (see `MAX_TOOL_IMAGE_BYTES`), so an image just
 * over that limit is still identified and refused in words, rather than cut
 * off mid-download and misreported as broken.
 */
const MAX_IMAGE_DOWNLOAD = 12 * 1024 * 1024;

async function fetchedImage(url: string, contentType: string, response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_IMAGE_DOWNLOAD) {
    await response.body?.cancel().catch(() => undefined);
    return `${url} is an image (${contentType}, ${Math.round(declared / (1024 * 1024))} MB) — too large to fetch for viewing.`;
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_IMAGE_DOWNLOAD) {
    return `${url} is an image (${contentType}, ${Math.round(bytes.length / (1024 * 1024))} MB) — too large to fetch for viewing.`;
  }
  let name = 'image';
  try {
    name = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() ?? '') || 'image';
  } catch { /* keep the default */ }
  const note = await offerToolImage({ bytes, name, origin: `WebFetch ${url}` });
  return `${url} is an image (${contentType.split(';')[0]!.trim()}). ${note}`;
}

export const webFetchDefinition = {
  name: 'WebFetch',
  description: 'Fetch the content of a URL and return it as text. '
    + 'An image URL (PNG, JPEG, WebP, GIF) is shown to you in the next message when this model can see images.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to fetch.' },
      max_length: { type: 'number', description: 'Maximum characters to return (default: 5000).' },
    },
    required: ['url'],
  },
};
