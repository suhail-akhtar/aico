/**
 * The Connections page's data: the provider catalogue, the connections, and the
 * managed policy that governs them.
 *
 * WHY a hook and not a store slice: only this page (and the add flow opened from the
 * Delivery board) reads it, and a connection is cheap to re-fetch after every action
 * (the engine returns the changed connection, the list is a handful of rows). The
 * provider catalogue starts as the shared constant so the tiles draw at once and the
 * engine's answer, which knows what is `supported`, replaces it.
 *
 * What it does not do: hold a token. No state here ever carries one.
 *
 * @module web/components/connections/useConnections
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import { PROVIDERS, type Connection, type ConnectionsPolicyView, type ProviderInfo } from '../../../../shared/connections/types';

export interface ConnectionsData {
  providers: readonly ProviderInfo[];
  connections: Connection[];
  policy: ConnectionsPolicyView | undefined;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  /** Fold one changed connection (an action's reply) into the list without a round trip. */
  upsert: (c: Connection) => void;
  drop: (id: string) => void;
}

export function useConnections(): ConnectionsData {
  const [providers, setProviders] = useState<readonly ProviderInfo[]>(PROVIDERS);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [policy, setPolicy] = useState<ConnectionsPolicyView | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [p, l] = await Promise.all([api.connectionProviders().catch(() => null), api.connectionList()]);
      if (!alive.current) return;
      if (p && Array.isArray(p.providers) && p.providers.length) setProviders(p.providers);
      setConnections(Array.isArray(l.connections) ? l.connections : []);
      setPolicy(l.policy);
      setError(null);
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const upsert = useCallback((c: Connection): void => {
    setConnections(cs => (cs.some(x => x.id === c.id) ? cs.map(x => (x.id === c.id ? c : x)) : [...cs, c]));
  }, []);
  const drop = useCallback((id: string): void => { setConnections(cs => cs.filter(c => c.id !== id)); }, []);

  return { providers, connections, policy, loading, error, refresh, upsert, drop };
}
