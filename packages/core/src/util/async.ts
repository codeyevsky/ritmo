/**
 * Promise plumbing shared by the providers, the metadata services and the
 * playback controller. Everything here is host-agnostic: only `setTimeout` and
 * `Date.now` are assumed.
 */

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}

export function withTimeout<T>(p: Promise<T>, ms: number, message?: string): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return p;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new Error(message ?? `Timed out after ${Math.round(ms)}ms`));
    }, ms);
    p.then(
      (value) => {
        if (settled) return;
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        if (settled) return;
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

export interface RetryOptions {
  attempts?: number;
  baseMs?: number;
  maxMs?: number;
  jitter?: boolean;
  shouldRetry?: (e: unknown, attempt: number) => boolean;
}

export async function retry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, Math.floor(opts.attempts ?? 3));
  const baseMs = Math.max(0, opts.baseMs ?? 300);
  const maxMs = Math.max(baseMs, opts.maxMs ?? 8_000);
  const jitter = opts.jitter ?? true;
  const shouldRetry = opts.shouldRetry ?? (() => true);

  let lastError: unknown = new Error('retry: no attempt was made');
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (attempt >= attempts || !shouldRetry(err, attempt)) break;
      const exp = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
      // Full jitter over the lower half of the window: enough to de-correlate
      // the five providers retrying the same flaky network at once.
      await sleep(jitter ? exp / 2 + Math.random() * (exp / 2) : exp);
    }
  }
  throw lastError;
}

export function pLimit(concurrency: number): <T>(fn: () => Promise<T>) => Promise<T> {
  const limit = Math.max(1, Math.floor(concurrency));
  const waiting: Array<() => void> = [];
  let active = 0;

  // The slot is handed straight to the next waiter instead of being freed and
  // re-taken: dequeuing costs a microtask, and a caller arriving inside that
  // gap would otherwise see a free slot that is already promised away.
  const release = (): void => {
    const next = waiting.shift();
    if (next) {
      next();
      return;
    }
    active -= 1;
  };

  return <T>(fn: () => Promise<T>): Promise<T> => {
    const exec = async (): Promise<T> => {
      try {
        return await fn();
      } finally {
        release();
      }
    };
    if (active < limit) {
      active += 1;
      return exec();
    }
    return new Promise<void>((resolve) => {
      waiting.push(resolve);
    }).then(exec);
  };
}

export function debounce<A extends unknown[]>(
  fn: (...a: A) => void,
  ms: number,
): ((...a: A) => void) & { cancel(): void; flush(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: A | undefined;

  const invoke = (): void => {
    timer = undefined;
    const args = pending;
    pending = undefined;
    if (args) fn(...args);
  };

  const call = (...args: A): void => {
    pending = args;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(invoke, Math.max(0, ms));
  };

  return Object.assign(call, {
    cancel(): void {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      pending = undefined;
    },
    flush(): void {
      if (timer === undefined) return;
      clearTimeout(timer);
      invoke();
    },
  });
}

export function throttle<A extends unknown[]>(
  fn: (...a: A) => void,
  ms: number,
): ((...a: A) => void) & { cancel(): void } {
  const window = Math.max(0, ms);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: A | undefined;
  let lastRun = 0;

  const run = (args: A): void => {
    lastRun = Date.now();
    fn(...args);
  };

  const call = (...args: A): void => {
    const remaining = window - (Date.now() - lastRun);
    if (timer === undefined && remaining <= 0) {
      run(args);
      return;
    }
    // Trailing edge: the last call inside the window still has to land, or the
    // progress bar would freeze on whatever the leading call happened to see.
    pending = args;
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      const queued = pending;
      pending = undefined;
      if (queued) run(queued);
    }, Math.max(0, remaining));
  };

  return Object.assign(call, {
    cancel(): void {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      pending = undefined;
    },
  });
}

export interface MemoizeOptions<A extends unknown[]> {
  ttlMs?: number;
  key?: (...a: A) => string;
  max?: number;
}

export function memoizeAsync<A extends unknown[], R>(
  fn: (...a: A) => Promise<R>,
  opts: MemoizeOptions<A> = {},
): ((...a: A) => Promise<R>) & { clear(): void } {
  const ttlMs = Math.max(0, opts.ttlMs ?? 0);
  const max = Math.max(1, Math.floor(opts.max ?? 256));
  const keyOf = opts.key ?? ((...a: A): string => JSON.stringify(a));

  interface Entry {
    promise: Promise<R>;
    /** 0 while in flight or when no TTL is configured. */
    expiresAt: number;
  }
  // Map preserves insertion order, which is all an LRU needs: a hit is
  // re-inserted, so the oldest key is always the first one out.
  const cache = new Map<string, Entry>();

  const call = (...args: A): Promise<R> => {
    const key = keyOf(...args);
    const hit = cache.get(key);
    if (hit) {
      if (hit.expiresAt === 0 || hit.expiresAt > Date.now()) {
        cache.delete(key);
        cache.set(key, hit);
        return hit.promise;
      }
      cache.delete(key);
    }

    // `entry` is only read after the first await, by which point it is set.
    let entry: Entry | undefined;
    const promise = (async () => {
      const value = await fn(...args);
      // TTL runs from settlement, so a slow call is not born already stale.
      if (entry) entry.expiresAt = ttlMs > 0 ? Date.now() + ttlMs : 0;
      return value;
    })();
    entry = { promise, expiresAt: 0 };
    // Failures are never cached: a rate-limited provider has to be reachable
    // again on the next call. The derived promise handles its own rejection;
    // the one handed to the caller stays untouched.
    promise.catch(() => {
      if (cache.get(key) === entry) cache.delete(key);
    });

    cache.set(key, entry);
    while (cache.size > max) {
      const oldest = cache.keys().next();
      if (oldest.done === true) break;
      cache.delete(oldest.value);
    }
    return promise;
  };

  return Object.assign(call, {
    clear(): void {
      cache.clear();
    },
  });
}

/** Collapses concurrent calls for the same key onto one in-flight promise. */
export function singleFlight<A extends unknown[], R>(
  fn: (...a: A) => Promise<R>,
  key: (...a: A) => string,
): (...a: A) => Promise<R> {
  const inflight = new Map<string, Promise<R>>();
  return (...args: A): Promise<R> => {
    const k = key(...args);
    const existing = inflight.get(k);
    if (existing) return existing;
    const started: Promise<R> = (async () => fn(...args))().finally(() => {
      if (inflight.get(k) === started) inflight.delete(k);
    });
    inflight.set(k, started);
    return started;
  };
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const step = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += step) out.push(items.slice(i, i + step));
  return out;
}
