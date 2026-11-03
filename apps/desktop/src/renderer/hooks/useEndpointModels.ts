import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { ClaudeModelList } from '../../shared/types';

/**
 * The models the configured endpoint lists (Anthropic API or the base URL),
 * shared by every model picker: one request, however many pickers are open.
 */

interface State {
  list: ClaudeModelList | null;
  loading: boolean;
}

let state: State = { list: null, loading: false };
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function setState(next: Partial<State>): void {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function loadEndpointModels(refresh = false): Promise<void> {
  if (inFlight && !refresh) return inFlight;
  setState({ loading: true });
  let request: Promise<void> | null = null;
  request = (async () => {
    try {
      const result = await window.electronAPI.listClaudeModels({ refresh });
      setState({
        list: result.success && result.data
          ? result.data
          : { models: [], endpoint: '', custom: false, error: result.error ?? 'Could not load the models', fetchedAt: Date.now() },
      });
    } catch (error) {
      setState({
        list: { models: [], endpoint: '', custom: false, error: error instanceof Error ? error.message : String(error), fetchedAt: Date.now() },
      });
    } finally {
      if (inFlight === request) inFlight = null;
      setState({ loading: false });
    }
  })();
  inFlight = request;
  return request;
}

/** Forget the list, e.g. after the key or base URL changed. */
export function invalidateEndpointModels(): void {
  setState({ list: null });
}

export function useEndpointModels() {
  const snapshot = useSyncExternalStore(subscribe, () => state);

  useEffect(() => {
    if (!state.list && !state.loading) void loadEndpointModels();
  }, [snapshot.list]);

  const refresh = useCallback(() => loadEndpointModels(true), []);
  return { list: snapshot.list, loading: snapshot.loading, refresh };
}

/** Test hook */
export function resetEndpointModelsForTests(): void {
  state = { list: null, loading: false };
  inFlight = null;
}
