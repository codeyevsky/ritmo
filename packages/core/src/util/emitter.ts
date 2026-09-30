/**
 * Synchronous fan-out used by the queue, the playback controller and the engine
 * adapters. Deliberately tiny: no wildcards, no async handlers, no ordering
 * guarantees beyond registration order.
 */

export type Handler<E> = (event: E) => void;

export class Emitter<E> {
  private readonly handlers = new Set<Handler<E>>();

  on(handler: Handler<E>): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  once(handler: Handler<E>): () => void {
    const wrapper: Handler<E> = (event) => {
      this.handlers.delete(wrapper);
      handler(event);
    };
    this.handlers.add(wrapper);
    return () => {
      this.handlers.delete(wrapper);
    };
  }

  emit(event: E): void {
    // Dispatch over a snapshot: handlers routinely unsubscribe themselves (or
    // each other) while the event is being delivered.
    for (const handler of [...this.handlers]) {
      try {
        handler(event);
      } catch (err) {
        // A throwing subscriber must never starve the ones behind it — one
        // broken UI listener would otherwise stall playback progress.
        console.error('[ritmo] event handler threw', err);
      }
    }
  }

  clear(): void {
    this.handlers.clear();
  }

  get size(): number {
    return this.handlers.size;
  }
}
