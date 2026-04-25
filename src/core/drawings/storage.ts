/**
 * Storage binding for drawings. Owns:
 * - The active adapter + scope.
 * - A debounced save with cancel-on-scope-change (generation counter).
 * - Auto-load on `attach` (matches TradingView's "set symbol → drawings appear").
 *
 * The binding does NOT know about drawing semantics — it just shuttles
 * snapshots between the controller and an opaque adapter.
 */

import type { Logger } from "../../types.js";
import type {
  DrawingScope,
  DrawingsSnapshot,
  DrawingsStorageAdapter,
} from "./types.js";

const DEFAULT_DEBOUNCE_MS = 250;

export interface StorageBindingDeps {
  readonly logger: Logger;
  readonly applySnapshot: (snapshot: DrawingsSnapshot) => void;
  readonly takeSnapshot: () => DrawingsSnapshot;
  readonly debounceMs?: number;
  readonly setTimeout?: (cb: () => void, ms: number) => number;
  readonly clearTimeout?: (id: number) => void;
}

export class StorageBinding {
  private readonly logger: Logger;
  private readonly applySnapshot: (snapshot: DrawingsSnapshot) => void;
  private readonly takeSnapshot: () => DrawingsSnapshot;
  private readonly debounceMs: number;
  private readonly timerSet: (cb: () => void, ms: number) => number;
  private readonly timerClear: (id: number) => void;

  private adapter: DrawingsStorageAdapter | null = null;
  private scope: DrawingScope | null = null;
  private debounceTimer: number | null = null;
  private generation = 0;
  private pending = false;
  private disposed = false;

  constructor(deps: StorageBindingDeps) {
    this.logger = deps.logger;
    this.applySnapshot = deps.applySnapshot;
    this.takeSnapshot = deps.takeSnapshot;
    this.debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.timerSet =
      deps.setTimeout ??
      ((cb, ms): number => globalThis.setTimeout(cb, ms) as unknown as number);
    this.timerClear =
      deps.clearTimeout ??
      ((id): void => { globalThis.clearTimeout(id); });
  }

  attach(adapter: DrawingsStorageAdapter, scope: DrawingScope): void {
    if (this.disposed) {
      return;
    }
    if (scope.symbol.length === 0) {
      this.logger.warn("[carta] drawings.attachStorage rejected — scope.symbol must not be empty");
      return;
    }
    this.cancelDebounce();
    this.generation += 1;
    this.adapter = adapter;
    this.scope = scope;
    void this.kickLoad(this.generation);
  }

  detach(): void {
    if (this.disposed) {
      return;
    }
    // Flush any pending edit before invalidating the generation — otherwise
    // a host swapping scope or detaching within the 250 ms debounce window
    // silently loses the user's last edit.
    this.flushPending();
    this.generation += 1;
    this.adapter = null;
    this.scope = null;
  }

  scheduleSave(): void {
    if (this.disposed || this.adapter === null) {
      return;
    }
    this.pending = true;
    if (this.debounceTimer !== null) {
      return;
    }
    const myGen = this.generation;
    this.debounceTimer = this.timerSet(() => {
      this.debounceTimer = null;
      if (myGen !== this.generation || !this.pending) {
        this.pending = false;
        return;
      }
      this.pending = false;
      const adapter = this.adapter;
      const scope = this.scope;
      if (adapter === null || scope === null) {
        return;
      }
      const snap = this.takeSnapshot();
      void adapter.save(scope, snap).catch((err: unknown) => {
        this.logger.warn("[carta] drawings:save failed", err);
      });
    }, this.debounceMs);
  }

  /** Force-flush any pending debounce immediately. Useful in tests. */
  flushPending(): void {
    if (this.debounceTimer !== null) {
      this.timerClear(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (!this.pending) {
      return;
    }
    this.pending = false;
    const adapter = this.adapter;
    const scope = this.scope;
    if (adapter === null || scope === null) {
      return;
    }
    const snap = this.takeSnapshot();
    void adapter.save(scope, snap).catch((err: unknown) => {
      this.logger.warn("[carta] drawings:save failed", err);
    });
  }

  destroy(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.cancelDebounce();
    this.adapter = null;
    this.scope = null;
  }

  hasAdapter(): boolean {
    return this.adapter !== null;
  }

  private cancelDebounce(): void {
    if (this.debounceTimer !== null) {
      this.timerClear(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.pending = false;
  }

  private async kickLoad(myGen: number): Promise<void> {
    const adapter = this.adapter;
    const scope = this.scope;
    if (adapter === null || scope === null) {
      return;
    }
    try {
      const snap = await adapter.load(scope);
      if (myGen !== this.generation || this.disposed) {
        return;
      }
      if (snap !== null) {
        this.applySnapshot(snap);
      }
    } catch (err: unknown) {
      if (myGen === this.generation) {
        this.logger.warn("[carta] drawings:load failed", err);
      }
    }
  }
}
