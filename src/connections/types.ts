/**
 * Connections' contract types, re-exported from `shared/connections/types.ts` so the
 * engine and every client read one definition (ADR 0039), plus the one engine-private
 * shape: what is stored on disk for a connection.
 *
 * @module connections/types
 */
import type { Connection, ProbeResult, ProviderId } from '../../shared/connections/types.js';

export * from '../../shared/connections/types.js';

/**
 * A connection as stored in `aicoHome()/connections/connections.json`. It carries the
 * vault NAME of its credential and nothing else about it; a value never reaches this
 * file, the log, a client or the model. Clients get {@link Connection}, which has
 * `hasCredential` in place of the name.
 */
export interface StoredConnection {
  id: string;
  provider: ProviderId;
  label: string;
  baseUrl: string;
  hosts: string[];
  insecureHttp?: boolean;
  caBundle?: string;
  disabled?: boolean;
  createdAt: string;
  createdBy: 'person' | 'agent';
  /** Vault credential name; present once a person has stored a token. */
  credential?: string;
  probe?: ProbeResult;
  /** The last request failed with 401/403 (token revoked or expired): the page says "Sign in again". */
  authFailedAt?: string;
}
