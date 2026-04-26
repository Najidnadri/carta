/**
 * Phase 13 Cycle B1 — keyboard hotkeys for drawing tools.
 *
 * Carta does not register hotkeys globally — `installHotkeys(chart)` does, on
 * `document`. The host can build their own narrower-scope handler against the
 * `keyboard:hotkey` event without using the helper.
 *
 * Recommended bindings (matches the published TradingView Alt-letter
 * convention where possible; we collapse `Alt+Shift+R` to `Alt+R` since
 * rectangle has no conflict in Carta):
 *
 *   Alt+T → trendline
 *   Alt+H → horizontalLine
 *   Alt+V → verticalLine
 *   Alt+F → fibRetracement
 *   Alt+R → rectangle
 *   Alt+Y → ray
 *   Alt+E → extendedLine
 *   Alt+G → horizontalRay  (G for "ray", since H is already horizontalLine)
 *   Alt+P → parallelChannel
 *   Alt+Shift+L → longPosition
 *   Alt+Shift+S → shortPosition
 *   Alt+N → text (note)
 *   Alt+B → callout (b for "bubble")
 *   Alt+W → arrow
 *   Alt+D → dateRange
 *   Alt+M → priceRange (m for "measure")
 *   Alt+K → priceDateRange
 *   Alt+Shift+P → pitchfork  (Alt+P is parallelChannel)
 *   Alt+Shift+G → gannFan    (Alt+G is horizontalRay)
 *   Alt+O → ellipse
 *
 * Filters: `event.repeat`, IME composition, and keydowns delivered while an
 * `<input>`/`<textarea>`/`contenteditable` is focused. Hosts can `preventDefault`
 * inside their `keyboard:hotkey` listener to suppress the default action
 * (`chart.drawings.beginCreate(binding)`).
 */

import type {
  CartaEventHandler,
  CartaEventMap,
  EventKey,
  KeyboardHotkeyBinding,
  KeyboardHotkeyPayload,
} from "../../types.js";
import type { DrawingsFacade } from "../drawings/DrawingsController.js";

/** Chart surface required by `installHotkeys`. Structurally typed to avoid a circular import. */
export interface HotkeysChart {
  on<K extends EventKey>(event: K, handler: CartaEventHandler<K>): void;
  off<K extends EventKey>(event: K, handler: CartaEventHandler<K>): void;
  emit<K extends EventKey>(event: K, payload: CartaEventMap[K]): void;
  readonly drawings: DrawingsFacade;
}

/**
 * Recommended Alt-letter → drawing-kind table. Lowercased.
 *
 * Phase 13 Cycle B.2 extended the table — keys may include modifier prefixes
 * `'shift+'` (e.g. `'shift+l'` for `Alt+Shift+L`) for tools that conflict with
 * existing TradingView Alt-letter bindings. The handler normalizes the active
 * key into `'<modifier>+<letter>'` before lookup.
 */
export const RECOMMENDED_HOTKEY_BINDINGS: Readonly<Record<string, KeyboardHotkeyBinding>> = Object.freeze({
  // Phase 13 Cycle B.1
  t: "trendline",
  h: "horizontalLine",
  v: "verticalLine",
  f: "fibRetracement",
  r: "rectangle",
  y: "ray",
  e: "extendedLine",
  g: "horizontalRay",
  p: "parallelChannel",
  // Phase 13 Cycle B.2
  "shift+l": "longPosition",
  "shift+s": "shortPosition",
  n: "text",
  b: "callout",
  w: "arrow",
  d: "dateRange",
  m: "priceRange",
  k: "priceDateRange",
  // Phase 13 Cycle C.1
  "shift+p": "pitchfork",
  "shift+g": "gannFan",
  o: "ellipse",
});

export interface InstallHotkeysOptions {
  /**
   * Element that the document-keydown filter treats as "active drawing tool
   * sink". Default = `document`; tests inject a stub.
   */
  readonly target?: Pick<Document, "addEventListener" | "removeEventListener"> | EventTarget;
  /**
   * Override the recommended-bindings table. Pass an empty object to suppress
   * Carta's default `beginCreate` action; the `keyboard:hotkey` event still
   * fires so hosts can react themselves.
   */
  readonly bindings?: Readonly<Record<string, KeyboardHotkeyBinding>>;
}

/**
 * Listen for `Alt+letter` keydowns at the document scope. For each one:
 *  1. Filter `event.repeat`, IME composition, input-element focus.
 *  2. Resolve the recommended `binding` (or `null`).
 *  3. Emit `keyboard:hotkey` on the chart.
 *  4. If `binding !== null` AND no listener called `preventDefault`, call
 *     `chart.drawings.beginCreate(binding)`.
 *
 * Returns a disposer.
 */
export function installHotkeys(chart: HotkeysChart, options?: InstallHotkeysOptions): () => void {
  const target: EventTarget = (options?.target as EventTarget | undefined) ?? document;
  const bindings = options?.bindings ?? RECOMMENDED_HOTKEY_BINDINGS;
  const handler = (raw: Event): void => {
    if (!(raw instanceof KeyboardEvent)) {
      return;
    }
    if (raw.repeat) {
      return;
    }
    if (raw.isComposing) {
      return;
    }
    if (isEditableTarget(raw.target)) {
      return;
    }
    if (!raw.altKey) {
      return;
    }
    const key = raw.key.toLowerCase();
    if (key.length !== 1) {
      return;
    }
    // Cycle B.2 — `Alt+Shift+letter` maps via `'shift+<letter>'` keys; bare
    // `Alt+letter` continues to map via `'<letter>'`. Shift-only is the only
    // extra modifier we honor here (Ctrl/Meta combinations are reserved).
    const lookupKey = raw.shiftKey ? `shift+${key}` : key;
    const binding = bindings[lookupKey] ?? null;
    const payload: KeyboardHotkeyPayload = Object.freeze({
      key,
      modifiers: Object.freeze({
        alt: raw.altKey,
        ctrl: raw.ctrlKey,
        meta: raw.metaKey,
        shift: raw.shiftKey,
      }),
      binding,
      originalEvent: raw,
    });
    chart.emit("keyboard:hotkey", payload);
    if (binding !== null && !raw.defaultPrevented) {
      raw.preventDefault();
      chart.drawings.beginCreate(binding);
    }
  };
  target.addEventListener("keydown", handler);
  return (): void => {
    target.removeEventListener("keydown", handler);
  };
}

/** Exported for tests; returns `true` when keydown should be ignored. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (target === null) {
    return false;
  }
  if (target instanceof HTMLInputElement) {
    return true;
  }
  if (target instanceof HTMLTextAreaElement) {
    return true;
  }
  if (target instanceof HTMLSelectElement) {
    return true;
  }
  if (target instanceof HTMLElement) {
    if (target.isContentEditable) {
      return true;
    }
    const attr = target.getAttribute("contenteditable");
    if (attr !== null && attr !== "false") {
      return true;
    }
  }
  return false;
}
