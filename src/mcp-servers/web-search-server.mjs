#!/usr/bin/env node

/**
 * MCP Server for Web Search
 * Provides internet search capabilities to Claude via JSON-RPC
 * 
 * Features:
 * - Google Search via SerpAPI (or fallback to URL fetching)
 * - DuckDuckGo Instant Answers
 * - Direct URL fetching with content extraction
 */

import { createInterface } from 'readline';
import https from 'https';
import http from 'http';

// Simple line-based JSON-RPC server over stdio
class MCPServer {
  constructor() {
    this.requestId = 1;
    this.rl = createInterface({
      input: process.stdin,
      output: null,
    });

    this.rl.on('line', (line) => this.handleLine(line));
  }

  async handleLine(line) {
    try {
      const request = JSON.parse(line);
      const response = await this.handleRequest(request);
      console.log(JSON.stringify(response));
    } catch (error) {
      console.error('Error:', error.message);
    }
  }

  async handleRequest(request) {
    const { jsonrpc, id, method, params } = request;

    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          serverInfo: {
            name: 'web-search-mcp',
            version: '1.0.0',
          },
        },
      };
    }

    if (method === 'tools/list') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          tools: [
            {
              name: 'google_search',
              description: 'Search Google for information on any topic',
              inputSchema: {
                type: 'object',
                properties: {
                  query: {
                    type: 'string',
                    description: 'Search query',
                  },
                  num_results: {
                    type: 'number',
                    description: 'Number of results to return (default: 5)',
                    default: 5,
                  },
                },
                required: ['query'],
              },
            },
            {
              name: 'fetch_url',
              description: 'Fetch and extract content from a specific URL',
              inputSchema: {
                type: 'object',
                properties: {
                  url: {
                    type: 'string',
                    description: 'URL to fetch',
                  },
                  extract_text: {
                    type: 'boolean',
                    description: 'Extract main text content (default: true)',
                    default: true,
                  },
                },
                required: ['url'],
              },
            },
            {
              name: 'duckduckgo_search',
              description: 'Search DuckDuckGo for information (privacy-friendly)',
              inputSchema: {
                type: 'object',
                properties: {
                  query: {
                    type: 'string',
                    description: 'Search query',
                  },
                },
                required: ['query'],
              },
            },
          ],
        },
      };
    }

    if (method === 'tools/call') {
      const { name, arguments: args } = params;

      let result;
      try {
        if (name === 'google_search') {
          result = await this.googleSearch(args.query, args.num_results || 5);
        } else if (name === 'fetch_url') {
          result = await this.fetchUrl(args.url, args.extract_text !== false);
        } else if (name === 'duckduckgo_search') {
          result = await this.duckduckgoSearch(args.query);
        } else {
          throw new Error(`Unknown tool: ${name}`);
        }

        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          },
        };
      } catch (error) {
        return {
          jsonrpc: '2.0',
          id,
          error: {
            code: -32603,
            message: 'Internal error',
            data: error.message,
          },
        };
      }
    }

    return {
      jsonrpc: '2.0',
      id,
      error: {
        code: -32601,
        message: 'Method not found',
      },
    };
  }

  async googleSearch(query, numResults = 5) {
    try {
      const apiKey = process.env.SERPAPI_KEY;

      if (apiKey) {
        const url = `https://serpapi.com/search?q=${encodeURIComponent(
          query,
        )}&num=${numResults}&api_key=${apiKey}`;
        return await this.fetchJson(url);
      } else {
        return await this.basicGoogleFallback(query, numResults);
      }
    } catch (error) {
      throw new Error(`Google search failed: ${error.message}`);
    }
  }

  async basicGoogleFallback(query, numResults) {
    try {
      const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(
        query,
      )}&num=${numResults}`;

      const content = await this.fetchUrl(searchUrl, true);

      const results = [];
      const pattern =
        /<h3[^>]*>.*?<a href="([^"]*)"[^>]*>([^<]+)<\/a>/gi;
      let match;
      let count = 0;

      while ((match = pattern.exec(content)) && count < numResults) {
        results.push({
          title: match[2],
          url: match[1],
          source: 'Google',
        });
        count++;
      }

      return {
        search_query: query,
        results:
          results.length > 0
            ? results
            : [{ note: 'Could not parse results. Please provide SERPAPI_KEY for better results.' }],
      };
    } catch (error) {
      return {
        search_query: query,
        error: `Google fallback search failed: ${error.message}`,
        note: 'Set SERPAPI_KEY environment variable for better results',
      };
    }
  }

  async duckduckgoSearch(query) {
    try {
      const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(
        query,
      )}&format=json`;
      const data = await this.fetchJson(url);

      return {
        search_query: query,
        instant_answer: data.AbstractText || 'No instant answer',
        related_topics: (data.RelatedTopics || []).slice(0, 5).map((t) => ({
          title: t.Text || t.Name,
          url: t.FirstURL,
        })),
        source: 'DuckDuckGo',
      };
    } catch (error) {
      throw new Error(`DuckDuckGo search failed: ${error.message}`);
    }
  }

  async fetchUrl(url, extractText = true) {
    return new Promise((resolve, reject) => {
      const protocol = url.startsWith('https') ? https : http;

      const options = {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        timeout: 10000,
      };

      protocol
        .get(url, options, (res) => {
          if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
            this.fetchUrl(res.headers.location, extractText)
              .then(resolve)
              .catch(reject);
            return;
          }

          if (res.statusCode !== 200) {
            reject(
              new Error(
                `HTTP ${res.statusCode}: ${res.statusMessage}`,
              ),
            );
            return;
          }

          let data = '';
          res.on('data', (chunk) => {
            data += chunk.toString('utf8');
            if (data.length > 1024 * 1024) {
              res.destroy();
            }
          });

          res.on('end', () => {
            if (extractText) {
              const text = this.extractTextFromHtml(data);
              resolve({
                url,
                status: res.statusCode,
                contentType: res.headers['content-type'],
                text: text.substring(0, 5000),
                length: text.length,
              });
            } else {
              resolve({
                url,
                status: res.statusCode,
                contentType: res.headers['content-type'],
                content: data.substring(0, 5000),
              });
            }
          });
        })
        .on('error', reject)
        .on('timeout', () => {
          reject(new Error('Request timeout'));
        });
    });
  }

  async fetchJson(url) {
    return new Promise((resolve, reject) => {
      const protocol = url.startsWith('https') ? https : http;

      const options = {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        timeout: 10000,
      };

      protocol
        .get(url, options, (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk.toString('utf8')));
          res.on('end', () => {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(new Error(`Invalid JSON response: ${e.message}`));
            }
          });
        })
        .on('error', reject);
    });
  }

  extractTextFromHtml(html) {
    let text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    text = text
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");

    return text;
  }
}

// Start the server
const server = new MCPServer();
console.error('[MCP Web Search Server] Started');

