/**
 * The headers production serves and the headers the test servers serve must be
 * the same table, or the end-to-end suite proves a different app than the one
 * that ships. This reads the real nginx files and compares.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CSP, securityHeaders } from './security-headers.ts';

const root = path.resolve(import.meta.dirname, '..');
const read = (rel: string) => readFileSync(path.join(root, rel), 'utf8');

function nginxHeaders(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of read('nginx/security-headers.conf').matchAll(
    /^add_header\s+(\S+)\s+"([^"]*)"\s+always;/gm,
  )) {
    out[m[1] as string] = m[2] as string;
  }
  return out;
}

describe('security headers', () => {
  it('nginx serves exactly the table the test servers use', () => {
    expect(nginxHeaders()).toEqual({ ...securityHeaders });
  });

  it('the CSP is strict: same-origin only, no inline script or style, no framing', () => {
    expect(CSP).toContain("default-src 'self'");
    expect(CSP).toContain("script-src 'self'");
    expect(CSP).toContain("frame-ancestors 'none'");
    expect(CSP).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
  });

  it('every nginx location that sets its own headers also includes the security headers', () => {
    const conf = read('nginx/nginx.conf');
    const blocks = [...conf.matchAll(/location[^{]*\{([^}]*)\}/g)].map((m) => m[1] as string);
    expect(blocks.length).toBeGreaterThan(4);
    for (const body of blocks) {
      if (/add_header|return 4|return 2/.test(body)) {
        expect(body, body).toContain('include /etc/nginx/security-headers.conf;');
      }
    }
  });

  it('never ships inline script or style in the page', () => {
    const html = read('index.html');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
    expect(html).not.toMatch(/<style/i);
    expect(html).not.toMatch(/\sstyle=/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
  });
});
