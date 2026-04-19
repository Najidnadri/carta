export type DirtyReason =
  | "layout"
  | "viewport"
  | "data"
  | "crosshair"
  | "theme"
  | "size";

export type FlushFn = (reasons: ReadonlySet<DirtyReason>) => void;

/**
 * Coalesces multiple `invalidate` calls into a single `requestAnimationFrame`
 * flush. Re-entrant `invalidate` calls during flush are safe: they land in
 * a fresh Set and schedule the next frame automatically.
 */
export class InvalidationQueue {
  private dirty = new Set<DirtyReason>();
  private rafId = 0;
  private disposed = false;
  private readonly flush: FlushFn;

  constructor(flush: FlushFn) {
    this.flush = flush;
  }

  invalidate(reason: DirtyReason): void {
    if (this.disposed) {
      return;
    }
    this.dirty.add(reason);
    if (this.rafId !== 0) {
      return;
    }
    this.rafId = requestAnimationFrame(this.run);
  }

  dispose(): void {
    this.disposed = true;
    if (this.rafId !== 0) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    this.dirty.clear();
  }

  private readonly run = (): void => {
    this.rafId = 0;
    if (this.disposed) {
      return;
    }
    const reasons = this.dirty;
    this.dirty = new Set();
    this.flush(reasons);
  };
}
