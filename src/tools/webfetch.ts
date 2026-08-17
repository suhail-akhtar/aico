import fetch from 'node-fetch';

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
  let text: string;

  if (contentType.includes('application/json')) {
    const json = await response.json();
    text = JSON.stringify(json, null, 2);
  } else {
    text = await response.text();
    // Strip HTML tags for readability
    if (contentType.includes('text/html')) {
      text = text
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
    }
  }

  if (text.length > maxLength) {
    return text.slice(0, maxLength) + `\n\n[... truncated at ${maxLength} chars]`;
  }
  return text;
}

export const webFetchDefinition = {
  name: 'WebFetch',
  description: 'Fetch the content of a URL and return it as text.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to fetch.' },
      max_length: { type: 'number', description: 'Maximum characters to return (default: 5000).' },
    },
    required: ['url'],
  },
};
