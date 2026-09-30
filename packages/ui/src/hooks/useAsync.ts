import { useCallback, useEffect, useRef, useState } from 'react';
import type { DependencyList } from 'react';

export interface UseAsyncOptions {
  /** Keeps the previous `data` visible during a re-fetch instead of blanking. */
  keepPrevious?: boolean;
  /** When false the effect does not run and `loading` stays false. */
  enabled?: boolean;
}

export interface UseAsyncResult<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
  reload(): void;
}

interface AsyncState<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
}

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

/**
 * The async primitive every view's three states are built on.
 *
 * `fn` is deliberately *not* part of the dependency list — inline closures
 * would re-fire the effect on every render. `deps` is the caller's contract for
 * when the work is actually different, exactly like `useMemo`.
 */
export function useAsync<T>(
  fn: () => Promise<T>,
  deps: DependencyList,
  opts?: UseAsyncOptions,
): UseAsyncResult<T> {
  const enabled = opts?.enabled ?? true;
  const keepPrevious = opts?.keepPrevious ?? false;

  const fnRef = useRef(fn);
  fnRef.current = fn;

  const [state, setState] = useState<AsyncState<T>>({
    data: undefined,
    error: undefined,
    loading: enabled,
  });
  const [nonce, setNonce] = useState(0);
  /** Guards against a superseded run resolving after a newer one. */
  const runRef = useRef(0);

  useEffect(() => {
    if (!enabled) {
      runRef.current++;
      setState((prev) => ({ data: keepPrevious ? prev.data : undefined, error: undefined, loading: false }));
      return;
    }

    const run = ++runRef.current;
    setState((prev) => ({
      data: keepPrevious ? prev.data : undefined,
      error: undefined,
      loading: true,
    }));

    let alive = true;
    fnRef
      .current()
      .then((data) => {
        if (!alive || run !== runRef.current) return;
        setState({ data, error: undefined, loading: false });
      })
      .catch((e: unknown) => {
        if (!alive || run !== runRef.current) return;
        setState((prev) => ({
          data: keepPrevious ? prev.data : undefined,
          error: toError(e),
          loading: false,
        }));
      });

    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce, enabled, keepPrevious]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return { data: state.data, error: state.error, loading: state.loading, reload };
}
