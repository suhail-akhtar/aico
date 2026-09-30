
import { offerToolImage } from './tool-images.js';
import { guardPageText, stripHiddenHtml, withNotice, type HiddenSample } from '../../shared/injection-guard.js';

export interface WebFetchInput {
  url: string;
  max_length?: number;
}

export async function webFetch(input: WebFetchInput): Promise<string> {
  const maxLength = input.max_length ?? 5000;
  const response = await fetch(input.url, {
    headers: {
      'User-Agent': 'aico/1.0.0',
    },
    redirect: 'follow',
  });

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
