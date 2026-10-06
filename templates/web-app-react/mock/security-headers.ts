/**
 * The response headers every environment serves the app with.
 *
 * Why this is one module: the production image (nginx/nginx.conf), the preview
 * server used by the end-to-end suite, and the mock gateway must agree, or the
 * suite would prove an app that production then breaks (a CSP that blocks a
 * script the build emits is only ever noticed in production). A unit test
 * parses nginx.conf and fails if this table and the file drift.
 *
 * The CSP is strict because the build is: Vite emits external scripts and one
 * stylesheet, there is no inline script or style in `index.html` (theme
 * initialisation is a same-origin file), and every request goes to the same
 * origin.
 */
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export const securityHeaders: Readonly<Record<string, string>> = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
};
