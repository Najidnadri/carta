import { noopLogger } from "./Logger.js";
import type { Logger } from "../../types.js";

export type EventHandler<T> = (payload: T) => void;

export interface EventBusOptions {
  readonly logger?: Logger;
}

/**
 * Typed pub/sub. Mapped-type handler sets keyed by `keyof M` give compile-time
 * payload enforcement — `bus.on('window:change', (p: string) => …)` is a type
 * error because `EventHandler<Window>` is not assignable to `EventHandler<string>`.
 *
 * Re-entrancy rules:
 * - `emit` snapshots the handler set to an array before invoking, so a handler
 *   that calls `off` (or `once` self-removing) does not cause the next
 *   listener to be skipped.
 * - Thrown handlers are caught and routed to `logger.error` so a broken
 *   subscriber cannot abort sibling handlers or poison the render pipeline.
 */
export class EventBus<M extends Record<string, unknown>> {
  private readonly listeners: { [K in keyof M]?: Set<EventHandler<M[K]>> } = {};
  private readonly logger: Logger;

  constructor(opts?: EventBusOptions) {
    this.logger = opts?.logger ?? noopLogger;
  }

  on<K extends keyof M>(key: K, handler: EventHandler<M[K]>): void {
    let set = this.listeners[key];
    if (set === undefined) {
      set = new Set();
      this.listeners[key] = set;
    }
    set.add(handler);
  }

  off<K extends keyof M>(key: K, handler: EventHandler<M[K]>): void {
    const set = this.listeners[key];
    if (set === undefined) {
      return;
    }
    set.delete(handler);
    if (set.size === 0) {
      this.listeners[key] = undefined;
    }
  }

  once<K extends keyof M>(key: K, handler: EventHandler<M[K]>): void {
    const wrapper: EventHandler<M[K]> = (payload) => {
      this.off(key, wrapper);
      try {
        handler(payload);
      } catch (err) {
        this.logger.error(`[carta] handler threw in once('${String(key)}')`, err);
      }
    };
    this.on(key, wrapper);
  }

  emit<K extends keyof M>(key: K, payload: M[K]): void {
    const set = this.listeners[key];
    if (set === undefined || set.size === 0) {
      return;
    }
    const snapshot = Array.from(set);
    for (const handler of snapshot) {
      try {
        handler(payload);
      } catch (err) {
        this.logger.error(`[carta] handler threw in on('${String(key)}')`, err);
      }
    }
  }

  listenerCount(key: keyof M): number {
    return this.listeners[key]?.size ?? 0;
  }

  removeAllListeners(): void {
    for (const key of Object.keys(this.listeners)) {
      this.listeners[key as keyof M] = undefined;
    }
  }
}
