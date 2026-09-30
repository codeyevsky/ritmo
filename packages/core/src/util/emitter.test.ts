import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Emitter } from './emitter';

let consoleError = vi.fn();

beforeEach(() => {
  consoleError = vi.fn();
  vi.spyOn(console, 'error').mockImplementation(consoleError);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Emitter', () => {
  it('delivers each event to every handler in registration order', () => {
    const seen: string[] = [];
    const bus = new Emitter<number>();
    bus.on((n) => seen.push(`a${n}`));
    bus.on((n) => seen.push(`b${n}`));
    bus.on((n) => seen.push(`c${n}`));
    bus.emit(1);
    bus.emit(2);
    expect(seen).toEqual(['a1', 'b1', 'c1', 'a2', 'b2', 'c2']);
  });

  it('stops delivering to an unsubscribed handler only', () => {
    const a = vi.fn();
    const b = vi.fn();
    const bus = new Emitter<void>();
    const off = bus.on(a);
    bus.on(b);
    off();
    bus.emit(undefined);
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('unsubscribing twice is harmless and leaves the other handlers alone', () => {
    const a = vi.fn();
    const b = vi.fn();
    const bus = new Emitter<void>();
    const off = bus.on(a);
    bus.on(b);
    off();
    off();
    expect(bus.size).toBe(1);
    bus.emit(undefined);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('a throwing handler does not starve the handlers behind it', () => {
    const before = vi.fn();
    const after = vi.fn();
    const bus = new Emitter<number>();
    bus.on(before);
    bus.on(() => {
      throw new Error('broken listener');
    });
    bus.on(after);
    expect(() => bus.emit(7)).not.toThrow();
    expect(before).toHaveBeenCalledWith(7);
    expect(after).toHaveBeenCalledWith(7);
    expect(consoleError).toHaveBeenCalledTimes(1);
  });

  it('a throwing handler stays subscribed for the next event', () => {
    const bus = new Emitter<void>();
    const thrower = vi.fn(() => {
      throw new Error('broken listener');
    });
    bus.on(thrower);
    bus.emit(undefined);
    bus.emit(undefined);
    expect(thrower).toHaveBeenCalledTimes(2);
  });

  it('once fires for exactly one event', () => {
    const handler = vi.fn();
    const bus = new Emitter<number>();
    bus.once(handler);
    bus.emit(1);
    bus.emit(2);
    bus.emit(3);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(1);
    expect(bus.size).toBe(0);
  });

  it('once can be cancelled before it ever fires', () => {
    const handler = vi.fn();
    const bus = new Emitter<void>();
    const off = bus.once(handler);
    off();
    expect(bus.size).toBe(0);
    bus.emit(undefined);
    expect(handler).not.toHaveBeenCalled();
  });

  it('a once handler that re-emits does not re-enter itself', () => {
    const bus = new Emitter<number>();
    const handler = vi.fn((n: number) => {
      if (n === 1) bus.emit(2);
    });
    bus.once(handler);
    bus.emit(1);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('a handler unsubscribing another mid-dispatch does not skip the rest of the snapshot', () => {
    const order: string[] = [];
    const bus = new Emitter<void>();
    const second = vi.fn(() => order.push('second'));
    const third = vi.fn(() => order.push('third'));
    bus.on(() => {
      order.push('first');
      offSecond();
    });
    const offSecond = bus.on(second);
    bus.on(third);

    bus.emit(undefined);
    // The snapshot taken at dispatch still contains `second`, so nothing after
    // it is skipped by the mutation.
    expect(order).toEqual(['first', 'second', 'third']);

    order.length = 0;
    bus.emit(undefined);
    expect(order).toEqual(['first', 'third']);
  });

  it('a handler unsubscribing itself mid-dispatch still finishes the current event', () => {
    const bus = new Emitter<number>();
    const seen: number[] = [];
    const off = bus.on((n) => {
      seen.push(n);
      off();
    });
    const tail = vi.fn();
    bus.on(tail);
    bus.emit(1);
    bus.emit(2);
    expect(seen).toEqual([1]);
    expect(tail).toHaveBeenCalledTimes(2);
  });

  it('a handler added mid-dispatch waits for the next event', () => {
    const late = vi.fn();
    const bus = new Emitter<number>();
    bus.on((n) => {
      if (n === 1) bus.on(late);
    });
    bus.emit(1);
    expect(late).not.toHaveBeenCalled();
    bus.emit(2);
    expect(late).toHaveBeenCalledTimes(1);
    expect(late).toHaveBeenCalledWith(2);
  });

  it('clear mid-dispatch still delivers to the rest of the snapshot', () => {
    const tail = vi.fn();
    const bus = new Emitter<void>();
    bus.on(() => bus.clear());
    bus.on(tail);
    bus.emit(undefined);
    expect(tail).toHaveBeenCalledTimes(1);
    expect(bus.size).toBe(0);
    bus.emit(undefined);
    expect(tail).toHaveBeenCalledTimes(1);
  });

  it('tracks the live handler count through on, once, unsubscribe and clear', () => {
    const bus = new Emitter<void>();
    expect(bus.size).toBe(0);
    const off = bus.on(() => undefined);
    bus.once(() => undefined);
    expect(bus.size).toBe(2);
    off();
    expect(bus.size).toBe(1);
    bus.clear();
    expect(bus.size).toBe(0);
  });

  it('emitting with no handlers is a no-op', () => {
    const bus = new Emitter<number>();
    expect(() => bus.emit(1)).not.toThrow();
    expect(consoleError).not.toHaveBeenCalled();
  });
});
