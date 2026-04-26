/**
 * Phase 13 Cycle D — DOM-overlay text editor for `text` and `callout`
 * drawings. The chart is a Pixi canvas which can't host text input, so we
 * mount a sibling `<input>` element positioned over the drawing's projected
 * anchor. Per-frame `transform: translate3d` keeps the editor anchored as
 * the user pans / zooms / pinches without losing focus or text mid-typing.
 *
 * Lifecycle:
 *   - `mount(...)`: insert into the host DOM, focus, pre-fill text.
 *   - `repositionTo(x, y)`: called every frame by the renderer with the
 *     current screen-space anchor (in CHART-CONTAINER-LOCAL CSS pixels).
 *   - `commit()`: invoke `onCommit` with the current text, then unmount.
 *   - `cancel()`: invoke `onCancel`, then unmount. No text persisted.
 *   - `unmount()`: drop the DOM node, detach listeners. Idempotent.
 *
 * Commit triggers: Enter (when not composing), blur. Cancel triggers: Esc.
 *
 * IME-safe: `event.isComposing` suppresses Enter while a composition is
 * active (Japanese / Chinese / Korean input methods).
 *
 * Shadow-DOM safe: caller passes the host element; `mount` appends to that
 * element's parent so the editor lives at the same DOM level as the chart's
 * canvas regardless of light vs shadow root.
 *
 * Hotkey suppression: the `<input>` element's existence already trips the
 * existing `isEditableTarget` check in `installHotkeys`, so chart letter /
 * Delete / Cmd+D shortcuts are ignored while the editor is focused.
 */

import type { DrawingId } from "./types.js";

export interface TextEditorOptions {
  readonly onCommit: (id: DrawingId, text: string) => void;
  readonly onCancel: (id: DrawingId) => void;
}

export interface MountArgs {
  readonly id: DrawingId;
  readonly initialText: string;
  /** Container the editor div should be appended to (chart's wrapper). */
  readonly host: HTMLElement;
  /** Initial screen-local position (chart-container coordinates). */
  readonly x: number;
  readonly y: number;
  /**
   * Phase 13 Cycle D — visual-style hints so the editor mimics the
   * underlying drawing (callout bubble vs plain text pin) instead of
   * reading like a foreign DOM input. Optional — defaults to a neutral
   * white pill if omitted.
   */
  readonly bubble?: {
    readonly bgColor: string;
    readonly textColor: string;
    readonly borderColor: string;
    readonly borderRadius: number;
    readonly width?: number;
    readonly height?: number;
  };
}

const EDITOR_DATA_ATTR = "data-carta-editor";

export class TextEditor {
  private readonly opts: TextEditorOptions;
  private el: HTMLTextAreaElement | null = null;
  private mountedId: DrawingId | null = null;
  private committing = false;

  constructor(opts: TextEditorOptions) {
    this.opts = opts;
  }

  isEditing(id: DrawingId): boolean {
    return this.mountedId !== null && this.mountedId === id;
  }

  isMounted(): boolean {
    return this.el !== null;
  }

  /** Returns the id currently being edited, or null when unmounted. */
  editingId(): DrawingId | null {
    return this.mountedId;
  }

  mount(args: MountArgs): void {
    // Replacing an active editor: commit the previous one before swapping
    // so the user's text isn't silently dropped.
    if (this.el !== null && this.mountedId !== null && this.mountedId !== args.id) {
      this.commit();
    }
    if (this.el === null) {
      // Phase 13 Cycle D — `<textarea>` so Shift+Enter inserts a newline
      // (Enter alone still commits via the keydown handler). Multi-line
      // matches the `\n`-aware text rendering in the callout pool.
      const el = document.createElement("textarea");
      el.setAttribute(EDITOR_DATA_ATTR, "");
      el.spellcheck = false;
      el.autocomplete = "off";
      el.rows = 1;
      el.style.resize = "none";
      el.style.overflow = "hidden";
      // Auto-grow on input: expand to fit content up to 10 rows, then scroll.
      el.addEventListener("input", this.onInput);
      // Position the editor at the host's top-left origin so translate3d
      // math computes from (0, 0); the per-frame reposition handles offset.
      const s = el.style;
      s.position = "absolute";
      s.left = "0";
      s.top = "0";
      s.zIndex = "10";
      s.padding = "2px 6px";
      s.outline = "none";
      // GPU-composited positioning — survives 60Hz reposition without thrash.
      s.transform = "translate3d(0,0,0)";
      s.willChange = "transform";
      el.addEventListener("keydown", this.onKeyDown);
      el.addEventListener("blur", this.onBlur);
      this.el = el;
    }
    // Apply per-mount bubble styling so the editor visually MATCHES the
    // drawing it edits (callout pill colors + radius, or a neutral pill
    // for plain `text` drawings). User experience: typing inside the
    // bubble itself, not into a foreign overlay.
    const s = this.el.style;
    if (args.bubble !== undefined) {
      s.background = args.bubble.bgColor;
      s.color = args.bubble.textColor;
      s.border = `1px solid ${args.bubble.borderColor}`;
      s.borderRadius = `${String(args.bubble.borderRadius)}px`;
      s.font = "12px/1.3 system-ui, -apple-system, Segoe UI, Helvetica, sans-serif";
      s.minWidth = args.bubble.width !== undefined ? `${String(args.bubble.width)}px` : "60px";
      s.boxShadow = "none";
    } else {
      s.background = "rgba(255,255,255,0.95)";
      s.color = "#0e1116";
      s.border = "1px solid currentColor";
      s.borderRadius = "3px";
      s.font = "12px/1.3 system-ui, -apple-system, Segoe UI, Helvetica, sans-serif";
      s.minWidth = "80px";
      s.boxShadow = "0 1px 4px rgba(0,0,0,0.15)";
    }
    this.mountedId = args.id;
    this.el.value = args.initialText;
    args.host.appendChild(this.el);
    this.repositionTo(args.x, args.y);
    // Size the editor to fit any pre-filled text (and the bubble's hint).
    this.onInput();
    // Defer focus + select to the next microtask so the dblclick / pointerup
    // that mounted us doesn't race with the focus call.
    queueMicrotask((): void => {
      if (this.el?.isConnected === true) {
        this.el.focus();
        this.el.select();
      }
    });
  }

  /** Reposition the editor to (x, y) in chart-container CSS pixels. */
  repositionTo(x: number, y: number): void {
    if (this.el === null) {
      return;
    }
    // Use translate3d so positioning is GPU-composited; CSS `top`/`left`
    // would trigger layout per frame.
    this.el.style.transform = `translate3d(${String(Math.round(x))}px, ${String(Math.round(y))}px, 0)`;
  }

  commit(): void {
    if (this.el === null || this.mountedId === null || this.committing) {
      return;
    }
    this.committing = true;
    const id = this.mountedId;
    const text = this.el.value;
    this.unmount();
    this.opts.onCommit(id, text);
    this.committing = false;
  }

  cancel(): void {
    if (this.el === null || this.mountedId === null) {
      return;
    }
    const id = this.mountedId;
    this.unmount();
    this.opts.onCancel(id);
  }

  unmount(): void {
    if (this.el === null) {
      return;
    }
    this.el.removeEventListener("keydown", this.onKeyDown);
    this.el.removeEventListener("blur", this.onBlur);
    this.el.removeEventListener("input", this.onInput);
    this.el.parentElement?.removeChild(this.el);
    this.el = null;
    this.mountedId = null;
  }

  destroy(): void {
    this.unmount();
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      this.cancel();
      return;
    }
    if (e.key === "Enter") {
      // IME composition guard — Enter during composition confirms the
      // candidate, not the editor, so we must ignore it. The browser fires
      // a non-composing Enter once composition ends.
      if (e.isComposing) {
        return;
      }
      // Shift+Enter (and Cmd/Ctrl+Enter) inserts a newline; plain Enter
      // commits. Mirrors GitHub / Slack / Linear conventions.
      if (e.shiftKey || e.metaKey || e.ctrlKey) {
        return;
      }
      e.preventDefault();
      this.commit();
    }
  };

  private readonly onBlur = (): void => {
    // Commit on blur unless we're already mid-commit (prevents recursion
    // when commit() removes the element which itself fires a blur event).
    if (this.committing) {
      return;
    }
    this.commit();
  };

  /**
   * Phase 13 Cycle D — auto-grow on input. Expands the textarea to fit
   * content up to 10 rows, then scrolls. Match `lineHeight × rows + padding`
   * via `scrollHeight` so we get exact pixel sizing without measuring text
   * directly.
   */
  private readonly onInput = (): void => {
    if (this.el === null) {
      return;
    }
    const el = this.el;
    // Reset height first so we can shrink if the user deleted content.
    el.style.height = "auto";
    // Compute line height from computed style; fall back to font-size * 1.4.
    const cs = window.getComputedStyle(el);
    let lineH = parseFloat(cs.lineHeight);
    if (!Number.isFinite(lineH) || lineH <= 0) {
      const fs = parseFloat(cs.fontSize);
      lineH = (Number.isFinite(fs) && fs > 0 ? fs : 12) * 1.4;
    }
    const padTop = parseFloat(cs.paddingTop) || 0;
    const padBot = parseFloat(cs.paddingBottom) || 0;
    const maxH = lineH * 10 + padTop + padBot;
    const desired = Math.min(el.scrollHeight, Math.ceil(maxH));
    el.style.height = `${String(desired)}px`;
    // Hide overflow until we hit the cap, then allow scroll.
    el.style.overflow = el.scrollHeight > maxH ? "auto" : "hidden";
  };
}
