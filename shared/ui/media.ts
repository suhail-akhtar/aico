/**
 * How a same-origin media URL in a rendered block becomes one the page can load.
 *
 * Generated images are served by the engine at `/api/attachments/file?…`, and
 * blocks carry that URL bare. The browser portal authenticates with a token
 * that an `<img>` cannot send as a header, so it registers a resolver that
 * appends it as a query parameter; the desktop app's `aico:` proxy adds the
 * token itself and registers nothing.
 *
 * Applied only where an image is *displayed*. What a block copies, downloads
 * or exports keeps the URL as written, so no token ever leaves in the source.
 *
 * @module shared/ui/media
 */

let resolver: ((url: string) => string) | null = null;

export function setMediaUrlResolver(fn: ((url: string) => string) | null): void {
  resolver = fn;
}

/** The URL to put in `src`: same-origin `/api/…` paths go through the resolver. */
export function mediaUrl(url: string): string;
export function mediaUrl(url: string | undefined): string | undefined;
export function mediaUrl(url: string | undefined): string | undefined {
  if (!url || !resolver) return url;
  if (!url.startsWith('/api/')) return url;
  try { return resolver(url); } catch { return url; }
}
