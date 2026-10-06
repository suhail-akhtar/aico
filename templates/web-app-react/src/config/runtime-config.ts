/**
 * Configuration read at start-up from `/config.json`, not baked in at build time.
 *
 * Why: one built image must run in every environment (12-factor: config in the
 * environment). A build-time `VITE_*` value would mean a rebuild per
 * environment and a different artifact in production than the one that was
 * tested. The production container writes `/config.json` from environment
 * variables at start (nginx/40-runtime-config.sh); dev and the e2e suite serve
 * `public/config.json`.
 *
 * Every URL is a same-origin path: the browser must never be pointed at another
 * origin that would receive the session cookie, so a value like
 * `https://evil.example/api` is rejected here rather than trusted. A bad file
 * stops the app with a readable error screen, not a half-working page.
 *
 * What it does not hold: secrets. Everything in this file is delivered to the
 * browser.
 */

import { z } from 'zod';

const sameOriginPath = z
  .string()
  .regex(/^\/(?!\/)[^\s\\]*$/, 'must be a path on this origin that starts with a single "/"');

export const configSchema = z.object({
  /** Where the API lives, relative to this origin. */
  apiBaseUrl: sameOriginPath.default('/api'),
  /** The gateway endpoint that starts sign-in (`rd` is appended). */
  loginUrl: sameOriginPath.default('/api/auth/start'),
  /** The gateway endpoint that ends the session. */
  logoutUrl: sameOriginPath.default('/api/auth/sign_out?rd=/'),
  /** A label shown nowhere by default; useful in bug reports. */
  environment: z.string().max(32).default('production'),
});

export type AppConfig = z.infer<typeof configSchema>;

export class ConfigError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'ConfigError';
  }
}

export async function loadConfig(fetchImpl: typeof fetch = fetch): Promise<AppConfig> {
  let raw: unknown;
  try {
    const response = await fetchImpl('/config.json', {
      cache: 'no-store',
      credentials: 'same-origin',
    });
    if (!response.ok) throw new ConfigError(`GET /config.json answered ${response.status}`);
    raw = await response.json();
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError('/config.json could not be read as JSON');
  }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.') || 'config'} ${i.message}`)
      .join('; ');
    throw new ConfigError(detail);
  }
  return parsed.data;
}
