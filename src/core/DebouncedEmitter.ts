export interface DebouncedEmitterClock {
  readonly setTimeout: (fn: () => void, ms: number) => number;
  readonly clearTimeout: (id: number) => void;
}

const defaultClock: DebouncedEmitterClock = {
  setTimeout: (fn, ms): number =>
    globalThis.setTimeout(fn, ms) as unknown as number,
  clearTimeout: (id): void => {
    globalThis.clearTimeout(id);
  },
};

/**
 * Leading-armed trailing debouncer.
 *
 * - First `push` arms a timer for `+delay`.
 * - Subsequent pushes while armed update the payload (last-wins) without
 *   resetting the timer; at trailing-edge the latest payload fires.
 * - A `push` after the fire re-arms a fresh timer.
 *
 * The "re-armed trailing" shape (vs. classic reset-on-every-push) is
 * intentional: during a long kinetic fling, the host starts receiving
 * `data:request` events every `delay` ms rather than waiting for the
 * fling to fully decay. See `plans/06-events.md` cycle-1 design notes.
 */
export class DebouncedEmitter<T> {
  private pending: { payload: T } | null = null;
  private timerId: number | null = null;
  private cancelled = false;
  private readonly fn: (payload: T) => void;
  private readonly delayMs: number;
  private readonly clock: DebouncedEmitterClock;

  constructor(delayMs: number, fn: (payload: T) => void, clock?: DebouncedEmitterClock) {
    this.delayMs = delayMs;
    this.fn = fn;
    this.clock = clock ?? defaultClock;
  }

  push(payload: T): void {
    if (this.cancelled) {
      return;
    }
    this.pending = { payload };
    if (this.timerId !== null) {
      return;
    }
    this.timerId = this.clock.setTimeout(this.onTimer, this.delayMs);
  }

  /**
   * Flush any pending payload immediately. No-op when nothing is pending
   * or after `cancel()`.
   */
  flushNow(): void {
    if (this.cancelled) {
      return;
    }
    this.clearTimer();
    const p = this.pending;
    if (p === null) {
      return;
    }
    this.pending = null;
    this.fn(p.payload);
  }

  /**
   * Cancel the pending fire. After `cancel()`, further `push` / `flushNow`
   * calls are no-ops — the emitter is dead. Used on `chart.destroy()`.
   */
  cancel(): void {
    this.cancelled = true;
    this.clearTimer();
    this.pending = null;
  }

  hasPending(): boolean {
    return this.pending !== null;
  }

  private readonly onTimer = (): void => {
    this.timerId = null;
    if (this.cancelled) {
      return;
    }
    const p = this.pending;
    if (p === null) {
      return;
    }
    this.pending = null;
    this.fn(p.payload);
  };

  private clearTimer(): void {
    if (this.timerId !== null) {
      this.clock.clearTimeout(this.timerId);
      this.timerId = null;
    }
  }
}
