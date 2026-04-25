import { Graphics, type Container } from "pixi.js";

/**
 * Per-series Graphics pool. Lifecycle:
 *
 * - `acquire()` — pops a free Graphics (or allocates one on first use), marks
 *   it in-use, and makes it visible. First-time Graphics are parented onto
 *   the series' layer.
 * - `releaseAll()` — called at the top of every series render pass. Flips
 *   every in-use Graphics back to the free list, clears their command
 *   buffers, and hides them.
 * - `destroy()` — called on `series.destroy()`. Destroys every Graphics in
 *   both lists and empties them; safe to call once.
 *
 * The pool never shrinks mid-session — high-water mark stays resident so
 * rapid pans don't thrash GC. See
 * [plans/07-series-rendering.md §3.1](plans/07-series-rendering.md).
 */
export class ShapePool {
  private readonly free: Graphics[] = [];
  private readonly inUse: Graphics[] = [];
  private readonly layer: Container;
  private destroyed = false;

  constructor(layer: Container) {
    this.layer = layer;
  }

  acquire(): Graphics {
    const popped = this.free.pop();
    const g = popped ?? new Graphics();
    if (g.parent === null) {
      this.layer.addChild(g);
    }
    g.visible = true;
    this.inUse.push(g);
    return g;
  }

  releaseAll(): void {
    for (const g of this.inUse) {
      g.clear();
      g.visible = false;
      this.free.push(g);
    }
    this.inUse.length = 0;
  }

  /** Current in-use count — tests + dev introspection. */
  activeCount(): number {
    return this.inUse.length;
  }

  /** Total pool size (free + inUse) — high-water mark so far. */
  totalCount(): number {
    return this.free.length + this.inUse.length;
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    for (const g of this.inUse) {
      g.destroy();
    }
    for (const g of this.free) {
      g.destroy();
    }
    this.inUse.length = 0;
    this.free.length = 0;
  }
}
