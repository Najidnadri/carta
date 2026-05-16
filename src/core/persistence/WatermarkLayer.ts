/**
 * Phase 15 Cycle A — text-only watermark overlay for `chart.exportPNG`.
 * Image watermarks (`Assets.load`-backed) land in cycle C.
 *
 * The layer is built per-export and destroyed after. It expects to live
 * as a child of the chart's render stage (added before the off-screen
 * RenderTexture render, removed after).
 */

import { Container, Text } from "pixi.js";
import type { WatermarkConfig } from "./types.js";

const DEFAULT_OPACITY = 0.45;
const DEFAULT_FONT_SIZE = 14;
const DEFAULT_FONT_FAMILY = "Inter, system-ui, sans-serif";
const PADDING = 12;

export class WatermarkLayer extends Container {
  constructor(
    config: WatermarkConfig,
    canvasWidth: number,
    canvasHeight: number,
    themeText: number,
  ) {
    super({ label: "carta:WatermarkLayer" });
    if (typeof config.text !== "string" || config.text.length === 0) {
      return;
    }
    const fontSize =
      typeof config.fontSize === "number" && Number.isFinite(config.fontSize)
        ? config.fontSize
        : DEFAULT_FONT_SIZE;
    const fontFamily = config.fontFamily ?? DEFAULT_FONT_FAMILY;
    const color = config.color ?? themeText;
    const opacity =
      typeof config.opacity === "number" && config.opacity >= 0 && config.opacity <= 1
        ? config.opacity
        : DEFAULT_OPACITY;
    const text = new Text({
      text: config.text,
      style: {
        fontFamily,
        fontSize,
        fill: color,
        align: "left",
      },
    });
    text.alpha = opacity;
    const w = Math.max(0, canvasWidth);
    const h = Math.max(0, canvasHeight);
    const tw = text.width;
    const th = text.height;
    const pos = config.position ?? "bottom-right";
    switch (pos) {
      case "top-left":
        text.position.set(PADDING, PADDING);
        break;
      case "top-right":
        text.position.set(Math.max(PADDING, w - tw - PADDING), PADDING);
        break;
      case "bottom-left":
        text.position.set(PADDING, Math.max(PADDING, h - th - PADDING));
        break;
      case "center":
        text.position.set(Math.max(0, (w - tw) / 2), Math.max(0, (h - th) / 2));
        break;
      case "bottom-right":
      default:
        text.position.set(
          Math.max(PADDING, w - tw - PADDING),
          Math.max(PADDING, h - th - PADDING),
        );
        break;
    }
    this.addChild(text);
  }
}
