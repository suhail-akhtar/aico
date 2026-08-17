import fetch from 'node-fetch';

export interface WebSearchInput {
  query: string;
  max_results?: number;
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * Web search using DuckDuckGo HTML (no API key required).
 * Falls back to a simple lite.duckduckgo.com scrape.
 */
export async function webSearch(input: WebSearchInput): Promise<{ results: SearchResult[] }> {
  const maxResults = input.max_results ?? 8;
  const query = encodeURIComponent(input.query);

  try {
    // Use DuckDuckGo HTML (lite) — no API key needed
    const url = `https://html.duckduckgo.com/html/?q=${query}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15_000);
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; aico/1.0)',
      },
      signal: controller.signal as AbortSignal,
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      return { results: [{ title: 'Search Error', url: '', snippet: `HTTP ${response.status}` }] };
    }

    const html = await response.text();
    const results: SearchResult[] = [];

    // Parse DuckDuckGo HTML results — extract result links and snippets
    const resultBlocks = html.split(/class="result__body"/g).slice(1);
    for (const block of resultBlocks) {
      if (results.length >= maxResults) break;

      // Extract URL from result__a href
      const urlMatch = block.match(/class="result__a"[^>]*href="([^"]+)"/);
      // Extract title text
      const titleMatch = block.match(/class="result__a"[^>]*>([^<]+)</);
      // Extract snippet
      const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);

      if (urlMatch) {
        let resultUrl = urlMatch[1];
        // DDG wraps URLs in a redirect — extract the actual URL
        const uddgMatch = resultUrl.match(/uddg=([^&]+)/);
        if (uddgMatch) resultUrl = decodeURIComponent(uddgMatch[1]);

        results.push({
          title: titleMatch ? titleMatch[1].trim() : 'Untitled',
          url: resultUrl,
          snippet: snippetMatch
            ? snippetMatch[1].replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim()
            : '',
        });
      }
    }

    if (results.length === 0) {
      return { results: [{ title: 'No results', url: '', snippet: `No results found for: ${input.query}` }] };
    }

    return { results };
  } catch (err) {
    return {
      results: [{
        title: 'Search Error',
        url: '',
        snippet: err instanceof Error ? err.message : String(err),
      }],
    };
  }
}

export const webSearchDefinition = {
  name: 'WebSearch',
  description: 'Search the web using DuckDuckGo and return results with titles, URLs, and snippets. Use WebFetch on result URLs to read full content.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query.' },
      max_results: { type: 'number', description: 'Maximum number of results to return (default: 8).' },
    },
    required: ['query'],
  },
};
