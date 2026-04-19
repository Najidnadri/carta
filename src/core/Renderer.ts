import { Application, Container, Graphics } from "pixi.js";
import type { Theme } from "../types.js";

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
 * Owns the Pixi `Application` and the 7-layer scene graph.
 *
 *   stage
 *     ├─ bgLayer          (full-canvas background + placeholder frame)
 *     ├─ gridLayer        (future: grid lines; reserved for cacheAsTexture)
 *     ├─ plotClip         (rect mask → scissor; non-render-group)
 *     │    ├─ seriesLayer (isRenderGroup = true)
 *     │    ├─ overlaysLayer
 *     │    └─ drawingsLayer
 *     ├─ crosshairLayer
 *     ├─ axesLayer
 *     ├─ legendLayer
 *     └─ tooltipLayer
 *
 * Only `seriesLayer` is a render group — see research §13 ("mask on render
 * group is valid but less optimized than mask on a plain container").
 */
export class Renderer {
  readonly app: Application;
  readonly stage: Container;

  readonly bgLayer = new Container({ label: "bgLayer" });
  readonly gridLayer = new Container({ label: "gridLayer" });
  readonly plotClip = new Container({ label: "plotClip" });
  readonly seriesLayer = new Container({ label: "seriesLayer", isRenderGroup: true });
  readonly overlaysLayer = new Container({ label: "overlaysLayer" });
  readonly drawingsLayer = new Container({ label: "drawingsLayer" });
  readonly crosshairLayer = new Container({ label: "crosshairLayer" });
  readonly axesLayer = new Container({ label: "axesLayer" });
  readonly legendLayer = new Container({ label: "legendLayer" });
  readonly tooltipLayer = new Container({ label: "tooltipLayer" });

  private readonly bgGraphics = new Graphics();
  private readonly clipMask = new Graphics();
  private destroyed = false;

  private constructor(app: Application) {
    this.app = app;
    this.stage = app.stage;

    this.bgLayer.addChild(this.bgGraphics);

    this.plotClip.addChild(this.seriesLayer, this.overlaysLayer, this.drawingsLayer);
    this.plotClip.addChild(this.clipMask);
    this.plotClip.mask = this.clipMask;

    this.stage.addChild(
      this.bgLayer,
      this.gridLayer,
      this.plotClip,
      this.crosshairLayer,
      this.axesLayer,
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
    });
    app.canvas.style.display = "block";
    app.canvas.style.width = "100%";
    app.canvas.style.height = "100%";
    options.container.appendChild(app.canvas);
    return new Renderer(app);
  }

  /** Applies a new plot rect: moves & resizes the clip mask. */
  layout(plotRect: PlotRect): void {
    const safeW = Math.max(0, plotRect.w);
    const safeH = Math.max(0, plotRect.h);
    this.plotClip.position.set(plotRect.x, plotRect.y);
    this.clipMask
      .clear()
      .rect(0, 0, safeW, safeH)
      .fill(0xffffff);
  }

  /** Draws the dark background + the placeholder plot frame. */
  renderFrame(theme: Theme, canvasW: number, canvasH: number, plotRect: PlotRect): void {
    this.bgGraphics
      .clear()
      .rect(0, 0, Math.max(0, canvasW), Math.max(0, canvasH))
      .fill(theme.background);

    if (plotRect.w > 0 && plotRect.h > 0) {
      this.bgGraphics
        .rect(plotRect.x + 0.5, plotRect.y + 0.5, plotRect.w - 1, plotRect.h - 1)
        .stroke({ width: 1, color: theme.frame, alpha: 1 });
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
    this.plotClip.mask = null;
    this.app.destroy(
      { removeView: true },
      { children: true, texture: true, textureSource: true, context: true },
    );
  }
}
