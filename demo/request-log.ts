export type RequestSource = "data:request" | "cache-hit-synthetic";

export interface RequestLogEntry {
  readonly seq: number;
  readonly at: number;
  readonly channelId: string;
  readonly kind: "ohlc" | "point" | "marker";
  readonly interval: number;
  readonly start: number;
  readonly end: number;
  readonly source: RequestSource;
}

export interface RequestLogOptions {
  readonly capacity?: number;
  readonly tbody?: HTMLElement | null;
  readonly footer?: HTMLElement | null;
  readonly clock?: () => number;
}

const DEFAULT_CAPACITY = 50;

/**
 * Bounded ring buffer + DOM table renderer for the demo's per-channel
 * data-request log. Append-and-drop: oldest row is removed when capacity
 * is reached so the DOM never grows past `capacity` rows. Rendered on
 * every push; for `capacity = 50`, full re-render is trivially cheap.
 */
export class RequestLog {
  private readonly entries: RequestLogEntry[] = [];
  private readonly capacity: number;
  private readonly tbody: HTMLElement | null;
  private readonly footer: HTMLElement | null;
  private readonly clock: () => number;
  private nextSeq = 1;

  constructor(opts: RequestLogOptions = {}) {
    this.capacity = Math.max(1, opts.capacity ?? DEFAULT_CAPACITY);
    this.tbody = opts.tbody ?? null;
    this.footer = opts.footer ?? null;
    this.clock = opts.clock ?? ((): number => performance.now());
  }

  push(entry: Omit<RequestLogEntry, "seq" | "at">): RequestLogEntry {
    const full: RequestLogEntry = {
      seq: this.nextSeq++,
      at: this.clock(),
      ...entry,
    };
    this.entries.push(full);
    if (this.entries.length > this.capacity) {
      this.entries.shift();
    }
    this.render();
    return full;
  }

  clear(): void {
    this.entries.length = 0;
    this.nextSeq = 1;
    this.render();
  }

  /** Snapshot of current entries in insertion order. */
  snapshot(): readonly RequestLogEntry[] {
    return this.entries.slice();
  }

  size(): number {
    return this.entries.length;
  }

  /** Total number of entries pushed since construction (for tests). */
  totalPushed(): number {
    return this.nextSeq - 1;
  }

  /**
   * Re-render the entire `<tbody>`. Cheap at capacity 50; if we ever raise
   * the cap, switch to incremental append + drop.
   */
  render(): void {
    if (this.tbody !== null) {
      const frag = document.createDocumentFragment();
      for (const e of this.entries) {
        frag.appendChild(this.buildRow(e));
      }
      this.tbody.replaceChildren(frag);
    }
    if (this.footer !== null) {
      this.footer.textContent = `${String(this.entries.length)} / ${String(this.capacity)} · #${String(this.totalPushed())}`;
    }
  }

  private buildRow(e: RequestLogEntry): HTMLTableRowElement {
    const tr = document.createElement("tr");
    tr.dataset.source = e.source;
    tr.dataset.kind = e.kind;
    tr.dataset.channel = e.channelId;
    appendCell(tr, String(e.seq), "seq");
    appendCell(tr, formatRelativeMs(e.at), "at");
    appendCell(tr, e.channelId, "channel");
    appendCell(tr, e.kind, "kind");
    appendCell(tr, formatInterval(e.interval), "ivl");
    appendCell(tr, formatRange(e.start, e.end), "range");
    appendCell(tr, e.source === "cache-hit-synthetic" ? "hit" : "miss", "source");
    return tr;
  }
}

function appendCell(row: HTMLTableRowElement, text: string, cls: string): void {
  const td = document.createElement("td");
  td.className = cls;
  td.textContent = text;
  row.appendChild(td);
}

function formatRelativeMs(at: number): string {
  if (!Number.isFinite(at)) {
    return "—";
  }
  return `${(at / 1000).toFixed(1)}s`;
}

function formatInterval(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) {
    return "—";
  }
  if (ms >= 86_400_000 && ms % 86_400_000 === 0) {
    return `${String(ms / 86_400_000)}D`;
  }
  if (ms >= 3_600_000 && ms % 3_600_000 === 0) {
    return `${String(ms / 3_600_000)}h`;
  }
  if (ms >= 60_000 && ms % 60_000 === 0) {
    return `${String(ms / 60_000)}m`;
  }
  return `${String(ms)}ms`;
}

function formatRange(start: number, end: number): string {
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return "—";
  }
  const fmt = (ms: number): string => {
    try {
      return new Date(ms).toISOString().slice(11, 16);
    } catch {
      return "—";
    }
  };
  return `${fmt(start)}–${fmt(end)}`;
}
