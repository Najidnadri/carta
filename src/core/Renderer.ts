import { Application, Container } from "pixi.js";

export interface RendererOptions {
  container: HTMLElement;
  width: number;
  height: number;
  background: number;
  devicePixelRatio: number;
  antialias?: boolean;
}

export class Renderer {
  readonly app: Application;
  readonly stage: Container;
  readonly seriesLayer: Container;
  readonly axesLayer: Container;
  readonly overlayLayer: Container;

  private constructor(app: Application) {
    this.app = app;
    this.stage = app.stage;
    this.seriesLayer = new Container();
    this.axesLayer = new Container();
    this.overlayLayer = new Container();
    this.stage.addChild(this.seriesLayer, this.axesLayer, this.overlayLayer);
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
    });
    app.canvas.style.display = "block";
    options.container.appendChild(app.canvas);
    return new Renderer(app);
  }

  resize(width: number, height: number): void {
    this.app.renderer.resize(width, height);
  }

  destroy(): void {
    this.app.destroy(true, { children: true });
  }
}
