/**
 * Phase 15 Cycle A — off-screen PNG render pipeline.
 *
 * Steps:
 *  1. Pre-flight clamp to `MAX_TEXTURE_SIZE` (16384 fallback on WebGPU).
 *  2. If gesture active, defer up to `deferTimeoutMs` waiting for `idle`.
 *  3. Suspend transient render-time state (crosshair / handles / drawing
 *     selection halo / ghost preview / marquee / hover affordance).
 *  4. Mutate `ConfigState` width/height to export dims (no `Renderer.resize`
 *     call so live canvas is undisturbed); set renderer.resolution = 1.
 *  5. Run `computeLayoutAndPaint` (chart's flush sans the final `render`).
 *  6. Add optional `WatermarkLayer` as a sibling of the stage.
 *  7. `renderer.render({ container: stage, target: rt, clear: true })`.
 *  8. `extract.canvas` + `toBlob`.
 *  9. Restore visibility flags, watermark, config, resolution. Re-flush
 *     onto the live canvas so the visible canvas is back to what the
 *     user expected.
 */

import { RenderTexture } from "pixi.js";
import type { Container, Renderer as PixiRenderer } from "pixi.js";
import {
  ExportError,
  type PngExportOptions,
  type WatermarkConfig,
} from "./types.js";
import { WatermarkLayer } from "./WatermarkLayer.js";
import { ImageWatermarkLayer } from "./ImageWatermarkLayer.js";
import type { TransientSuspendToken } from "../drawings/DrawingsController.js";

const DEFAULT_SCALE = 2;
const DEFAULT_FORMAT: "image/png" = "image/png";
const DEFAULT_DEFER_TIMEOUT_MS = 2000;
const WEBGPU_FALLBACK_MAX_TEXTURE_SIZE = 16384;
const MEMORY_WARNING_BYTES = 64_000_000; // 64 MB

/**
 * Friend interface — read/write handle for the export pipeline. Lives on
 * the chart's surface so this module stays pure (testable) and the chart
 * keeps its private state private.
 */
export interface ExportContext {
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  readonly themeText: number;
  readonly themeBackground: number;
  readonly stage: Container;
  readonly pixiRenderer: {
    readonly extract: {
      canvas(options: { target: RenderTexture; antialias?: boolean }): HTMLCanvasElement | OffscreenCanvas;
    };
    resolution: number;
    render(args: { container: Container; target: RenderTexture; clear: boolean }): void;
    readonly gl?: WebGL2RenderingContext;
  };
  /** Hide the chart's transient overlay layers; returns a restore callback. */
  hideTransientLayers(): () => void;
  /** Suspend drawings transient state (selection halo, ghost, hover). */
  suspendDrawings(): TransientSuspendToken;
  resumeDrawings(token: TransientSuspendToken): void;
  /** Cycle C — mount a watermark layer on the stage; returns an unmount callback. */
  mountWatermarkChild(child: Container): () => void;
  /** Run chart layout + paint into the stage at the supplied CSS dims. */
  computeLayoutAndPaint(cssWidth: number, cssHeight: number): void;
  /** Re-flush the chart onto the live canvas at the original dims. */
  reflushOriginal(): void;
  /** Emit a chart event without exposing the chart's full emitter. */
  emit(
    event:
      | "export:ready"
      | "export:deferred"
      | "export:failed"
      | "export:size-clamped",
    payload: unknown,
  ): void;
  isGestureActive(): boolean;
  /**
   * Subscribe to the `'idle'` event; returns an unsubscribe function. Used
   * to drive the defer-on-gesture wait.
   */
  onIdleOnce(handler: () => void): () => void;
  isDisposed(): boolean;
  readonly logger: { warn(msg: string, ...args: readonly unknown[]): void };
}

function detectMaxTextureSize(
  pixiRenderer: ExportContext["pixiRenderer"],
): number {
  const gl = pixiRenderer.gl;
  if (gl !== undefined && typeof gl.getParameter === "function") {
    try {
      const v: unknown = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      if (typeof v === "number" && Number.isFinite(v) && v > 0) {
        return v;
      }
    } catch {
      // fall through to WebGPU fallback
    }
  }
  return WEBGPU_FALLBACK_MAX_TEXTURE_SIZE;
}

function clampDims(
  requestedW: number,
  requestedH: number,
  max: number,
  emit: ExportContext["emit"],
): { w: number; h: number } {
  const safeW = Math.max(1, Math.floor(requestedW));
  const safeH = Math.max(1, Math.floor(requestedH));
  const clampedW = Math.min(safeW, max);
  const clampedH = Math.min(safeH, max);
  if (clampedW !== safeW || clampedH !== safeH) {
    emit("export:size-clamped", {
      requested: { w: safeW, h: safeH },
      clamped: { w: clampedW, h: clampedH },
      max,
    });
  }
  return { w: clampedW, h: clampedH };
}

function awaitIdle(
  ctx: ExportContext,
  deferTimeoutMs: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let unsub: (() => void) | null = null;
    const timeout = setTimeout(() => {
      if (unsub !== null) {
        unsub();
        unsub = null;
      }
      reject(new ExportError("EBUSY", "gesture did not settle within deferTimeoutMs"));
    }, deferTimeoutMs);
    unsub = ctx.onIdleOnce(() => {
      if (ctx.isDisposed()) {
        clearTimeout(timeout);
        reject(new ExportError("CANCELLED", "chart disposed during export defer"));
        return;
      }
      if (ctx.isGestureActive()) {
        // Re-arm. Another gesture started before we got a clean frame.
        if (unsub !== null) {
          unsub();
        }
        unsub = ctx.onIdleOnce(() => {
          clearTimeout(timeout);
          resolve();
        });
        return;
      }
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function canvasToBlob(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  mime: string,
  quality: number | undefined,
): Promise<Blob> {
  if ("convertToBlob" in canvas && typeof canvas.convertToBlob === "function") {
    return canvas.convertToBlob(
      quality !== undefined ? { type: mime, quality } : { type: mime },
    );
  }
  // HTMLCanvasElement path.
  return new Promise<Blob>((resolve, reject) => {
    const c = canvas as HTMLCanvasElement;
    if (typeof c.toBlob !== "function") {
      reject(new ExportError("GENERIC", "canvas.toBlob is not available in this runtime"));
      return;
    }
    c.toBlob(
      (b) => {
        if (b === null) {
          reject(new ExportError("GENERIC", "canvas.toBlob returned null"));
          return;
        }
        resolve(b);
      },
      mime,
      quality,
    );
  });
}

export async function exportChartPng(
  ctx: ExportContext,
  opts: PngExportOptions = {},
): Promise<Blob> {
  if (ctx.isDisposed()) {
    throw new ExportError("CANCELLED", "chart disposed");
  }
  const scale =
    typeof opts.scale === "number" && Number.isFinite(opts.scale) && opts.scale > 0
      ? opts.scale
      : DEFAULT_SCALE;
  const cssW =
    typeof opts.width === "number" && Number.isFinite(opts.width) && opts.width > 0
      ? opts.width
      : ctx.canvasWidth;
  const cssH =
    typeof opts.height === "number" && Number.isFinite(opts.height) && opts.height > 0
      ? opts.height
      : ctx.canvasHeight;
  const requestedW = cssW * scale;
  const requestedH = cssH * scale;
  const maxTex = detectMaxTextureSize(ctx.pixiRenderer);
  const { w, h } = clampDims(requestedW, requestedH, maxTex, (e, p) => { ctx.emit(e, p); });

  if (w * h * 4 > MEMORY_WARNING_BYTES) {
    ctx.logger.warn(
      `[carta] exportPNG: large export (${String(w)}x${String(h)}, ~${String(Math.round((w * h * 4) / 1024 / 1024))} MB) — may exceed mobile memory budget`,
    );
  }

  if (ctx.isGestureActive()) {
    ctx.emit("export:deferred", { reason: "gesture" });
    try {
      await awaitIdle(ctx, opts.deferTimeoutMs ?? DEFAULT_DEFER_TIMEOUT_MS);
    } catch (err: unknown) {
      const code =
        err instanceof ExportError && err.code === "EBUSY" ? "EBUSY" : "GENERIC";
      const message =
        err instanceof Error
          ? err.message
          : "unknown deferral failure";
      ctx.emit("export:failed", { code, message });
      throw err;
    }
  }

  if (ctx.isDisposed()) {
    const err = new ExportError("CANCELLED", "chart disposed during defer");
    ctx.emit("export:failed", { code: err.code, message: err.message });
    throw err;
  }

  if (ctx.isDisposed()) {
    const err = new ExportError("CANCELLED", "chart disposed before export start");
    ctx.emit("export:failed", { code: err.code, message: err.message });
    throw err;
  }
  const restoreVisibility = ctx.hideTransientLayers();
  const drawingsToken = ctx.suspendDrawings();
  const prevResolution = ctx.pixiRenderer.resolution;
  let rt: RenderTexture | null = null;
  let blob: Blob;
  let watermarkLayer: WatermarkLayer | ImageWatermarkLayer | null = null;
  let unmountWatermark: (() => void) | null = null;
  try {
    if (ctx.isDisposed()) {
      throw new ExportError("CANCELLED", "chart disposed before render");
    }
    rt = RenderTexture.create({ width: w, height: h, resolution: 1 });
    ctx.pixiRenderer.resolution = 1;
    // Compute layout at export dims, paint into stage. The render call
    // below targets the RenderTexture; the live canvas backbuffer is
    // untouched.
    ctx.computeLayoutAndPaint(w, h);
    if (ctx.isDisposed()) {
      throw new ExportError("CANCELLED", "chart disposed during layout");
    }
    if (opts.watermark !== undefined) {
      const built = await buildWatermark(opts.watermark, w, h, ctx.themeText);
      if (built !== null) {
        watermarkLayer = built;
        unmountWatermark = ctx.mountWatermarkChild(built);
      }
    }
    if (ctx.isDisposed()) {
      throw new ExportError("CANCELLED", "chart disposed during watermark mount");
    }
    ctx.pixiRenderer.render({
      container: ctx.stage,
      target: rt,
      clear: true,
    });
    if (ctx.isDisposed()) {
      throw new ExportError("CANCELLED", "chart disposed before extract");
    }
    const canvas = ctx.pixiRenderer.extract.canvas({ target: rt, antialias: true });
    if (ctx.isDisposed()) {
      throw new ExportError("CANCELLED", "chart disposed before toBlob");
    }
    const mime: string = opts.format ?? DEFAULT_FORMAT;
    blob = await canvasToBlob(canvas, mime, opts.quality);
    if (ctx.isDisposed()) {
      throw new ExportError("CANCELLED", "chart disposed during toBlob");
    }
  } catch (err: unknown) {
    // If the chart was destroyed mid-flight, classify ANY error as
    // CANCELLED. Pixi v8 internals throw various raw TypeErrors when
    // called against a destroyed renderer; the host doesn't care about
    // those — they care that the contract said `chart.destroy()` cancels
    // pending exports.
    if (ctx.isDisposed()) {
      const cancelled =
        err instanceof ExportError && err.code === "CANCELLED"
          ? err
          : new ExportError("CANCELLED", "chart disposed during export");
      ctx.emit("export:failed", { code: cancelled.code, message: cancelled.message });
      throw cancelled;
    }
    const message = err instanceof Error ? err.message : "unknown export failure";
    // Map a CORS-tainted watermark image's `SecurityError` at extract-time
    // to WATERMARK_FAILED so the host sees a specific code.
    let code: "EBUSY" | "CANCELLED" | "GENERIC" | "WATERMARK_FAILED" =
      err instanceof ExportError ? err.code : "GENERIC";
    if (code === "GENERIC" && watermarkLayer !== null && (err as { name?: string } | null)?.name === "SecurityError") {
      code = "WATERMARK_FAILED";
    }
    ctx.emit("export:failed", { code, message });
    if (err instanceof ExportError) { throw err; }
    throw new ExportError(code, message);
  } finally {
    // Cleanup must not itself throw — wrap each op. After `chart.destroy()`,
    // the renderer's GL state is null and `RenderTexture.destroy` /
    // `ctx.pixiRenderer.*` reads will throw. Swallow silently — the host
    // is already in the destroy path.
    if (unmountWatermark !== null) {
      try { unmountWatermark(); } catch { /* ignore */ }
    }
    if (watermarkLayer !== null) {
      try { watermarkLayer.destroy(); } catch { /* ignore */ }
    }
    if (rt !== null) {
      try {
        rt.destroy(true);
      } catch {
        // ignore — renderer disposed
      }
    }
    if (!ctx.isDisposed()) {
      try {
        ctx.pixiRenderer.resolution = prevResolution;
      } catch {
        // ignore
      }
    }
    try {
      ctx.resumeDrawings(drawingsToken);
    } catch {
      // ignore — controller may be torn down
    }
    try {
      restoreVisibility();
    } catch {
      // ignore — layers may be destroyed
    }
    if (!ctx.isDisposed()) {
      try {
        ctx.reflushOriginal();
      } catch {
        // ignore — chart raced into destroy after our last isDisposed check
      }
    }
  }
  ctx.emit("export:ready", { width: w, height: h, bytes: blob.size });
  return blob;
}

async function buildWatermark(
  config: WatermarkConfig,
  canvasWidth: number,
  canvasHeight: number,
  themeText: number,
): Promise<WatermarkLayer | ImageWatermarkLayer | null> {
  // Image branch wins when both are supplied.
  if (config.image !== undefined) {
    const layer = new ImageWatermarkLayer();
    const imgOpts = config.image;
    try {
      await layer.load(imgOpts.url, canvasWidth, canvasHeight, {
        ...(config.position !== undefined ? { position: config.position } : {}),
        ...(config.opacity !== undefined ? { opacity: config.opacity } : {}),
        ...(imgOpts.scale !== undefined ? { scale: imgOpts.scale } : {}),
        ...(imgOpts.maxWidth !== undefined ? { maxWidth: imgOpts.maxWidth } : {}),
        ...(imgOpts.maxHeight !== undefined ? { maxHeight: imgOpts.maxHeight } : {}),
      });
    } catch (err: unknown) {
      try { layer.destroy(); } catch { /* ignore */ }
      // Wrap PixiJS internal failure modes in a host-friendly message so
      // the trader sees "what went wrong" not "Cannot read property X of
      // null". Common causes: 404 (Loader rejects), DNS fail (Loader
      // rejects), CORS-no-CORS-headers (browser rejects Image.decode for
      // some origins), decode failure (corrupt body).
      const raw = err instanceof Error ? err.message : String(err);
      const friendly = `watermark image failed to load from "${imgOpts.url}" — check the URL is reachable and serves CORS headers if cross-origin (raw: ${raw})`;
      throw new ExportError("WATERMARK_FAILED", friendly);
    }
    return layer;
  }
  if (typeof config.text === "string" && config.text.length > 0) {
    return new WatermarkLayer(config, canvasWidth, canvasHeight, themeText);
  }
  return null;
}

void (null as unknown as PixiRenderer);
