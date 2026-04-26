import { Application, Container, Graphics } from "pixi.js";
import type { Pane } from "../pane/Pane.js";
import type { Theme } from "../../types.js";

export interface RendererOptions {
  readonly container: HTMLElement;
  readonly width: number;
  readonly height: number;
  readonly background: number;
  readonly devicePixelRatio: number;
  readonly antialias?: boolean;
}

export interface PlotRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * Owns the Pixi `Application` and the chart-level scene graph. Per-pane
 * subtrees (`gridLayer`, `plotClip`, `seriesLayer`, …) live inside `Pane`
 * instances and are appended under `paneRoot`.
 *
 *   stage
 *     ├─ bgLayer                (full-canvas background; per-pane frames)
 *     ├─ paneRoot               (one child Container per pane, translated by layout)
 *     │    └─ paneContainer × N
 *     │         ├─ gridLayer
 *     │         ├─ plotClip (mask → scissor)
 *     │         │    ├─ seriesLayer (isRenderGroup = true)
 *     │         │    ├─ overlaysLayer
 *     │         │    └─ drawingsLayer
 *     │         └─ priceAxis labels (siblings of plotClip)
 *     ├─ crosshairLinesLayer    (chart-wide vert + active-pane horz)
 *     ├─ axesLayer              (TimeAxis only — PriceAxis lives per-pane)
 *     ├─ drawingsHandlesLayer
 *     ├─ crosshairTagsLayer     (per-pane price tags + chart-wide time tag)
 *     ├─ legendLayer
 *     └─ tooltipLayer
 *
 * Phase 14 cycle A back-compat: the legacy `plotClip` / `seriesLayer` /
 * `gridLayer` / `overlaysLayer` / `drawingsLayer` getters delegate to the
 * primary pane's containers so existing host code that touches them keeps
 * working. Cycle B's drag-resize work removes the delegates.
 */
export class Renderer {
  readonly app: Application;
  readonly stage: Container;

  readonly bgLayer = new Container({ label: "bgLayer" });
  readonly paneRoot = new Container({ label: "paneRoot" });
  /** Phase 14 Cycle A — separator lines + drag handles between panes. */
  readonly separatorLayer = new Container({ label: "separatorLayer" });
  readonly crosshairLinesLayer = new Container({ label: "crosshairLinesLayer", eventMode: "none" });
  readonly axesLayer = new Container({ label: "axesLayer" });
  readonly drawingsHandlesLayer = new Container({ label: "drawingsHandlesLayer", eventMode: "none" });
  readonly crosshairTagsLayer = new Container({ label: "crosshairTagsLayer", eventMode: "none" });
  readonly legendLayer = new Container({ label: "legendLayer" });
  readonly tooltipLayer = new Container({ label: "tooltipLayer" });

  private readonly bgGraphics = new Graphics();
  private destroyed = false;
  private primary: Pane | null = null;

  private constructor(app: Application) {
    this.app = app;
    this.stage = app.stage;

    this.bgLayer.addChild(this.bgGraphics);

    this.stage.addChild(
      this.bgLayer,
      this.paneRoot,
      this.separatorLayer,
      this.crosshairLinesLayer,
      this.axesLayer,
      this.drawingsHandlesLayer,
      this.crosshairTagsLayer,
      this.legendLayer,
      this.tooltipLayer,
    );
  }

  static async create(options: RendererOptions): Promise<Renderer> {
    const app = new Application();
    await app.init({
      width: options.width,
      height: options.height,
      background: options.background,
      resolution: options.devicePixelRatio,
      antialias: options.antialias ?? true,
      autoDensity: true,
      autoStart: false,
      sharedTicker: false,
      // Phase 13 Cycle C.3 — preserve the GL back buffer between frames so
      // hosts (and the test harness) can `readPixels` / `canvas.toDataURL`
      // / `app.renderer.extract.canvas` without a black-frame race.
      preserveDrawingBuffer: true,
    });
    const canvasStyle = app.canvas.style;
    canvasStyle.display = "block";
    canvasStyle.width = "100%";
    canvasStyle.height = "100%";
    canvasStyle.touchAction = "none";
    canvasStyle.userSelect = "none";
    app.canvas.tabIndex = 0;
    canvasStyle.outline = "none";
    canvasStyle.setProperty("-webkit-user-select", "none");
    canvasStyle.setProperty("-webkit-tap-highlight-color", "transparent");
    options.container.style.overscrollBehavior = "contain";
    if (options.container.style.position === "" || options.container.style.position === "static") {
      options.container.style.position = "relative";
    }
    options.container.appendChild(app.canvas);
    const r = new Renderer(app);
    r.hostContainer = options.container;
    return r;
  }

  /**
   * Phase 13 Cycle D — host container exposed for DOM-overlay siblings
   * (text editor, future styling panel).
   */
  hostContainer: HTMLElement | null = null;

  /**
   * Bind the primary pane. Called once during chart construction so the
   * renderer's legacy getters (`plotClip`, `seriesLayer`, etc.) delegate to
   * its containers.
   */
  setPrimaryPane(pane: Pane): void {
    if (this.primary === pane) {
      return;
    }
    this.primary = pane;
    if (pane.paneContainer.parent !== this.paneRoot) {
      this.paneRoot.addChild(pane.paneContainer);
    }
  }

  /** Append a non-primary pane's container under `paneRoot`. */
  attachPane(pane: Pane): void {
    if (pane.paneContainer.parent !== this.paneRoot) {
      this.paneRoot.addChild(pane.paneContainer);
    }
  }

  /** Detach a pane's container from `paneRoot`. Caller still owns destroy. */
  detachPane(pane: Pane): void {
    if (pane.paneContainer.parent === this.paneRoot) {
      this.paneRoot.removeChild(pane.paneContainer);
    }
  }

  /**
   * Phase 14 Cycle B — re-order a pane's `paneContainer` under `paneRoot`.
   * Visual y-translate alone keeps non-overlapping content on canvas, but
   * PixiJS hit-test + event-bubble walks `children` in array order — so
   * the divider's 24 CSS-px touch hit zone (which overlaps into adjacent
   * panes by 12 px) needs the child order to match logical pane order.
   *
   * No-op when the pane is not currently parented to `paneRoot` (e.g.,
   * caller is mid-detach).
   */
  reorderPane(pane: Pane, newIndex: number): void {
    if (this.destroyed) {
      return;
    }
    if (pane.paneContainer.parent !== this.paneRoot) {
      return;
    }
    const len = this.paneRoot.children.length;
    if (len === 0) {
      return;
    }
    const safeIndex = Math.max(0, Math.min(newIndex, len - 1));
    this.paneRoot.setChildIndex(pane.paneContainer, safeIndex);
  }

  // ─── Legacy getter shims (cycle A back-compat) ──────────────────────────

  get gridLayer(): Container {
    return this.requirePrimary().gridLayer;
  }

  get plotClip(): Container {
    return this.requirePrimary().plotClip;
  }

  get seriesLayer(): Container {
    return this.requirePrimary().seriesLayer;
  }

  get overlaysLayer(): Container {
    return this.requirePrimary().overlaysLayer;
  }

  get drawingsLayer(): Container {
    return this.requirePrimary().drawingsLayer;
  }

  private requirePrimary(): Pane {
    if (this.primary === null) {
      throw new Error("[carta] Renderer: legacy layer accessed before primary pane was bound");
    }
    return this.primary;
  }

  /**
   * Update the renderer's resolution (DPR) and resize.
   */
  setResolution(dpr: number): void {
    if (this.destroyed) {
      return;
    }
    if (!Number.isFinite(dpr) || dpr <= 0) {
      return;
    }
    this.app.renderer.resolution = dpr;
    this.app.renderer.resize(this.app.renderer.width / dpr, this.app.renderer.height / dpr);
  }

  /**
   * Phase 14 Cycle A — paint the canvas background plus one frame stroke
   * per pane rect. Single-pane invocation paints a single rect identical to
   * the prior single-pane output.
   */
  renderFrame(theme: Theme, canvasW: number, canvasH: number, paneRects: readonly PlotRect[]): void {
    this.bgGraphics
      .clear()
      .rect(0, 0, Math.max(0, canvasW), Math.max(0, canvasH))
      .fill(theme.background);

    for (const rect of paneRects) {
      if (rect.w > 0 && rect.h > 0) {
        this.bgGraphics
          .rect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1)
          .stroke({ width: 1, color: theme.frame, alpha: 1 });
      }
    }
  }

  /** Asks Pixi to render the stage. Called by the invalidator's flush. */
  render(): void {
    if (this.destroyed) {
      return;
    }
    this.app.renderer.render(this.stage);
  }

  resize(width: number, height: number): void {
    if (this.destroyed) {
      return;
    }
    this.app.renderer.resize(width, height);
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.primary = null;
    this.app.destroy(
      { removeView: true },
      { children: true, texture: true, textureSource: true, context: true },
    );
  }
}
