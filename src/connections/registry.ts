/**
 * Which adapter speaks which provider, and what the product knows about each provider.
 *
 * A registry rather than an import list so that a new provider is one `registerAdapter` call
 * (and, for the page, one entry in `shared/connections/types.ts` PROVIDERS), and so a test can
 * register a fake adapter to prove the generic code never assumes GitHub. `builtin.ts` registers
 * the adapters that ship; this file imports none of them (no cycle, no cost for a client that
 * only wants the provider list).
 *
 * @module connections/registry
 */

import { PROVIDERS, type ProviderId, type ProviderInfo } from '../../shared/connections/types.js';
import type { ProviderAdapter } from './adapter.js';

const adapters = new Map<ProviderId, ProviderAdapter>();

export function registerAdapter(adapter: ProviderAdapter): void { adapters.set(adapter.id, adapter); }
export function adapterFor(provider: ProviderId): ProviderAdapter | undefined { return adapters.get(provider); }

/** Tests: drop an adapter registered by a test. */
export function unregisterAdapter(provider: ProviderId): void { adapters.delete(provider); }

/** The providers a person can pick: the catalogue, with `supported` true only where an adapter is registered. */
export function providerCatalogue(): ProviderInfo[] {
  return PROVIDERS.map(p => ({ ...p, supported: adapters.has(p.id) }));
}

export function providerInfo(id: ProviderId): ProviderInfo | undefined {
  return providerCatalogue().find(p => p.id === id);
}
