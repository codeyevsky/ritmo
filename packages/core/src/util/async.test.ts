import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chunk,
  debounce,
  memoizeAsync,
  pLimit,
  retry,
  singleFlight,
  sleep,
  throttle,
  withTimeout,
} from './async';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2024-06-15T12:00:00.000Z'));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('sleep', () => {
  it('resolves after the requested delay and treats a negative delay as zero', async () => {
    const done = vi.fn();
    void sleep(50).then(done);
    void sleep(-50).then(done);
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(50);
    expect(done).toHaveBeenCalledTimes(2);
  });
});

describe('retry', () => {
  it('returns the first success without arming a timer', async () => {
    const fn = vi.fn(async (attempt: number) => `ok-${attempt}`);
    await expect(retry(fn)).resolves.toBe('ok-1');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives up after `attempts` tries and rethrows the last error', async () => {
    const errors = [new Error('e1'), new Error('e2'), new Error('e3')];
    const fn = vi.fn(async (attempt: number) => {
      throw errors[attempt - 1]!;
    });
    const settled = retry(fn, { attempts: 3, baseMs: 10, jitter: false }).catch(
      (e: unknown) => e,
    );
    await vi.runAllTimersAsync();
    expect(await settled).toBe(errors[2]);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('stops immediately when shouldRetry says no', async () => {
    const fn = vi.fn(async () => {
      throw new Error('fatal');
    });
    const shouldRetry = vi.fn(() => false);
    const settled = retry(fn, { attempts: 5, baseMs: 10, jitter: false, shouldRetry }).catch(
      (e: unknown) => e,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(shouldRetry).toHaveBeenCalledTimes(1);
    expect(await settled).toBeInstanceOf(Error);
  });

  it('passes the error and the 1-based attempt number to shouldRetry', async () => {
    const boom = new Error('boom');
    const seen: Array<[unknown, number]> = [];
    const settled = retry(
      async () => {
        throw boom;
      },
      {
        attempts: 3,
        baseMs: 10,
        jitter: false,
        shouldRetry: (e, attempt) => {
          seen.push([e, attempt]);
          return true;
        },
      },
    ).catch(() => undefined);
    await vi.runAllTimersAsync();
    await settled;
    // Not called on the final attempt: there is nothing left to decide.
    expect(seen).toEqual([
      [boom, 1],
      [boom, 2],
    ]);
  });

  it('grows the backoff exponentially and caps it at maxMs', async () => {
    const start = Date.now();
    const at: number[] = [];
    const settled = retry(
      async () => {
        at.push(Date.now() - start);
        throw new Error('again');
      },
      { attempts: 4, baseMs: 100, maxMs: 250, jitter: false },
    ).catch(() => undefined);
    await vi.runAllTimersAsync();
    await settled;
    expect(at).toEqual([0, 100, 300, 550]);
  });

  it('keeps a jittered delay inside the upper half of the backoff window', async () => {
    const run = async (random: number): Promise<number[]> => {
      vi.spyOn(Math, 'random').mockReturnValue(random);
      const start = Date.now();
      const at: number[] = [];
      const settled = retry(
        async () => {
          at.push(Date.now() - start);
          throw new Error('again');
        },
        { attempts: 2, baseMs: 100, jitter: true },
      ).catch(() => undefined);
      await vi.runAllTimersAsync();
      await settled;
      return at;
    };
    expect(await run(0)).toEqual([0, 50]);
    expect(await run(1)).toEqual([0, 100]);
  });
});

describe('withTimeout', () => {
  it('rejects with the supplied message once the deadline passes', async () => {
    const assertion = expect(
      withTimeout(new Promise<never>(() => undefined), 1_000, 'provider took too long'),
    ).rejects.toThrow('provider took too long');
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
  });

  it('names the deadline in the default message', async () => {
    const assertion = expect(
      withTimeout(new Promise<never>(() => undefined), 1_500),
    ).rejects.toThrow('Timed out after 1500ms');
    await vi.advanceTimersByTimeAsync(1_500);
    await assertion;
  });

  it('does not reject when the promise wins, and clears the timer', async () => {
    const p = withTimeout(Promise.resolve('artwork'), 1_000);
    await expect(p).resolves.toBe('artwork');
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(p).resolves.toBe('artwork');
  });

  it('passes an Error rejection through untouched', async () => {
    const boom = new Error('404');
    await expect(withTimeout(Promise.reject(boom), 1_000)).rejects.toBe(boom);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('wraps a non-Error rejection in an Error', async () => {
    await expect(withTimeout(Promise.reject('boom'), 1_000)).rejects.toThrow('boom');
    await expect(withTimeout(Promise.reject('boom'), 1_000)).rejects.toBeInstanceOf(Error);
  });

  it('returns the original promise when there is no usable deadline', () => {
    const p = Promise.resolve(1);
    expect(withTimeout(p, 0)).toBe(p);
    expect(withTimeout(p, -1)).toBe(p);
    expect(withTimeout(p, Number.NaN)).toBe(p);
  });
});

describe('pLimit', () => {
  it('never runs more than `concurrency` tasks at once and keeps each result', async () => {
    const limit = pLimit(3);
    let live = 0;
    let peak = 0;
    const task = (i: number): Promise<number> =>
      limit(async () => {
        live += 1;
        peak = Math.max(peak, live);
        await sleep((i % 4) * 10 + 5);
        live -= 1;
        return i;
      });

    const all = Promise.all(Array.from({ length: 12 }, (_, i) => task(i)));
    await vi.runAllTimersAsync();
    expect(await all).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(peak).toBe(3);
    expect(live).toBe(0);
  });

  it('does not admit an extra task in the gap between a release and the dequeue', async () => {
    const limit = pLimit(1);
    let live = 0;
    let peak = 0;
    const body = async (label: string): Promise<string> => {
      live += 1;
      peak = Math.max(peak, live);
      await sleep(50);
      live -= 1;
      return label;
    };

    let firstInner: Promise<string> | undefined;
    const first = limit(() => {
      firstInner = Promise.resolve('first');
      return firstInner;
    });
    const second = limit(() => body('second'));
    // A continuation on the running task's own promise is queued ahead of the
    // limiter's dequeue, so it observes whatever slot accounting the release
    // left behind.
    const third = firstInner!.then(() => limit(() => body('third')));

    await vi.runAllTimersAsync();
    expect(await Promise.all([first, second, third])).toEqual(['first', 'second', 'third']);
    expect(peak).toBe(1);
  });

  it('treats a concurrency below one as one', async () => {
    const limit = pLimit(0);
    let live = 0;
    let peak = 0;
    const task = (): Promise<void> =>
      limit(async () => {
        live += 1;
        peak = Math.max(peak, live);
        await sleep(5);
        live -= 1;
      });
    const all = Promise.all([task(), task(), task()]);
    await vi.runAllTimersAsync();
    await all;
    expect(peak).toBe(1);
  });

  it('propagates a task rejection without wedging the queue', async () => {
    const limit = pLimit(1);
    const failing = limit(async () => {
      await sleep(5);
      throw new Error('nope');
    });
    const following = limit(async () => {
      await sleep(5);
      return 'ran';
    });
    const settled = failing.catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    expect(await settled).toBeInstanceOf(Error);
    expect(await following).toBe('ran');
  });
});

describe('debounce', () => {
  it('runs once with the last arguments after the quiet period', () => {
    const fn = vi.fn<(n: number) => void>();
    const d = debounce(fn, 100);
    d(1);
    d(2);
    d(3);
    vi.advanceTimersByTime(99);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(3);
  });

  it('restarts the timer on every call', () => {
    const fn = vi.fn<(n: number) => void>();
    const d = debounce(fn, 100);
    d(1);
    vi.advanceTimersByTime(60);
    d(2);
    vi.advanceTimersByTime(60);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(40);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(2);
  });

  it('cancel drops the pending call and the pending arguments', () => {
    const fn = vi.fn<(n: number) => void>();
    const d = debounce(fn, 100);
    d(1);
    d.cancel();
    vi.advanceTimersByTime(1_000);
    expect(fn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    // A cancel must not leave stale arguments behind for a later flush.
    d.flush();
    expect(fn).not.toHaveBeenCalled();
  });

  it('flush runs the pending call now and consumes the timer', () => {
    const fn = vi.fn<(n: number) => void>();
    const d = debounce(fn, 100);
    d(7);
    d.flush();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(7);
    vi.advanceTimersByTime(1_000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('flush with nothing pending is a no-op', () => {
    const fn = vi.fn<(n: number) => void>();
    const d = debounce(fn, 100);
    d.flush();
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('throttle', () => {
  it('fires the leading edge synchronously', () => {
    const fn = vi.fn<(n: number) => void>();
    const t = throttle(fn, 100);
    t(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(1);
  });

  it('collapses every call inside the window into exactly one trailing call', () => {
    const fn = vi.fn<(n: number) => void>();
    const t = throttle(fn, 100);
    t(1);
    t(2);
    t(3);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith(3);
    vi.advanceTimersByTime(1_000);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('fires on the leading edge again once the window has gone quiet', () => {
    const fn = vi.fn<(n: number) => void>();
    const t = throttle(fn, 100);
    t(1);
    vi.advanceTimersByTime(200);
    t(2);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith(2);
  });

  it('cancel drops the queued trailing call', () => {
    const fn = vi.fn<(n: number) => void>();
    const t = throttle(fn, 100);
    t(1);
    t(2);
    t.cancel();
    vi.advanceTimersByTime(1_000);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(1);
  });
});

describe('memoizeAsync', () => {
  it('calls through once per distinct argument list', async () => {
    const fn = vi.fn(async (n: number) => n * 2);
    const m = memoizeAsync(fn);
    expect(await m(2)).toBe(4);
    expect(await m(2)).toBe(4);
    expect(await m(3)).toBe(6);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('hands concurrent callers the same in-flight promise', async () => {
    const fn = vi.fn(async (n: number) => {
      await sleep(10);
      return n;
    });
    const m = memoizeAsync(fn);
    const a = m(1);
    const b = m(1);
    expect(a).toBe(b);
    await vi.runAllTimersAsync();
    expect(await a).toBe(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('keeps entries forever when no ttl is configured', async () => {
    const fn = vi.fn(async () => 'x');
    const m = memoizeAsync(fn);
    await m();
    vi.advanceTimersByTime(31_536_000_000);
    await m();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('expires an entry ttlMs after it settled', async () => {
    const fn = vi.fn(async () => 'x');
    const m = memoizeAsync(fn, { ttlMs: 1_000 });
    await m();
    vi.advanceTimersByTime(999);
    await m();
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2);
    await m();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('times the ttl from settlement, not from the call', async () => {
    const fn = vi.fn(async () => {
      await sleep(900);
      return 'slow';
    });
    const m = memoizeAsync(fn, { ttlMs: 1_000 });
    const first = m();
    await vi.runAllTimersAsync();
    await first;
    // 900 ms of the ttl would already be gone if it ran from the call.
    vi.advanceTimersByTime(500);
    await m();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('evicts the least recently used key once max is exceeded', async () => {
    const fn = vi.fn(async (n: number) => n);
    const m = memoizeAsync(fn, { max: 2 });
    await m(1);
    await m(2);
    await m(1); // refreshes 1, so 2 is now the oldest
    await m(3); // evicts 2
    expect(fn).toHaveBeenCalledTimes(3);
    await m(1);
    expect(fn).toHaveBeenCalledTimes(3);
    await m(2);
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('does not cache a rejection', async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('rate limited');
      return 'ok';
    });
    const m = memoizeAsync(fn);
    await expect(m()).rejects.toThrow('rate limited');
    await expect(m()).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('uses a custom key function to decide identity', async () => {
    const fn = vi.fn(async (id: string, _etag: string) => id);
    const m = memoizeAsync(fn, { key: (id) => id });
    await m('a', 'v1');
    await m('a', 'v2');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('clear drops every entry', async () => {
    const fn = vi.fn(async () => 'x');
    const m = memoizeAsync(fn);
    await m();
    m.clear();
    await m();
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe('singleFlight', () => {
  it('collapses concurrent calls per key, not across keys', async () => {
    const fn = vi.fn(async (id: string) => {
      await sleep(10);
      return id;
    });
    const sf = singleFlight(fn, (id) => id);
    const a = sf('x');
    const b = sf('x');
    const c = sf('y');
    expect(a).toBe(b);
    expect(c).not.toBe(a);
    await vi.runAllTimersAsync();
    expect(await a).toBe('x');
    expect(await c).toBe('y');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('releases the key once the call settles', async () => {
    const fn = vi.fn(async (id: string) => {
      await sleep(10);
      return id;
    });
    const sf = singleFlight(fn, (id) => id);
    const first = sf('x');
    await vi.runAllTimersAsync();
    await first;
    const second = sf('x');
    expect(second).not.toBe(first);
    await vi.runAllTimersAsync();
    expect(await second).toBe('x');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('releases the key after a rejection too', async () => {
    const fn = vi.fn(async () => {
      throw new Error('nope');
    });
    const sf = singleFlight(fn, () => 'k');
    await expect(sf()).rejects.toThrow('nope');
    await expect(sf()).rejects.toThrow('nope');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('delivers the same rejection to every collapsed caller', async () => {
    const fn = vi.fn(async () => {
      await sleep(10);
      throw new Error('nope');
    });
    const sf = singleFlight(fn, () => 'k');
    const a = sf().catch((e: unknown) => e);
    const b = sf().catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    expect(await a).toBe(await b);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('chunk', () => {
  it('leaves a short final chunk when the length is not a multiple', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('wraps every item on its own at size 1', () => {
    expect(chunk(['a', 'b', 'c'], 1)).toEqual([['a'], ['b'], ['c']]);
  });

  it('returns no chunks for an empty input', () => {
    expect(chunk([], 10)).toEqual([]);
    expect(chunk([], 1)).toEqual([]);
  });

  it('returns one chunk when the size covers the whole input', () => {
    expect(chunk([1, 2, 3], 3)).toEqual([[1, 2, 3]]);
    expect(chunk([1, 2, 3], 99)).toEqual([[1, 2, 3]]);
  });

  it('floors the size and never goes below one, so it cannot loop forever', () => {
    expect(chunk([1, 2, 3], 2.9)).toEqual([[1, 2], [3]]);
    expect(chunk([1, 2, 3], 0)).toEqual([[1], [2], [3]]);
    expect(chunk([1, 2, 3], -5)).toEqual([[1], [2], [3]]);
  });

  it('copies rather than aliasing the source', () => {
    const src = [1, 2, 3, 4];
    const out = chunk(src, 2);
    out[0]!.push(99);
    expect(src).toEqual([1, 2, 3, 4]);
  });
});
