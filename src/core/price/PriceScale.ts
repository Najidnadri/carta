import { asPixel, asPrice, type Pixel, type Price } from "../../types.js";

export interface PriceScaleMargins {
  readonly top: number;
  readonly bottom: number;
}

export interface PriceScaleInput {
  readonly domainMin: Price;
  readonly domainMax: Price;
  readonly pixelHeight: number;
  readonly margins?: PriceScaleMargins | undefined;
}

export const DEFAULT_PRICE_MARGINS: PriceScaleMargins = Object.freeze({
  top: 0.08,
  bottom: 0.08,
});

const ZERO_HEIGHT_INFLATE_FRACTION = 0.01;
const ZERO_HEIGHT_INFLATE_MIN = 0.5;

/**
 * Pure linear projection from price (value) to y-pixel inside a plot rect.
 *
 * Conventions:
 * - Pixi y grows downward, so `valueToPixel(effectiveMax) ≈ 0` and
 *   `valueToPixel(effectiveMin) ≈ pixelHeight`.
 * - `margins.top` and `margins.bottom` are fractions of the requested domain
 *   height, added around it; the effective plotted domain is always wider
 *   than `[domainMin, domainMax]` by those fractions.
 * - When `domainMin === domainMax`, the scale inflates by ±1%·|min| (or
 *   ±0.5 when min === 0) before margins so labels still render.
 * - `valid === false` when inputs are non-finite, `pixelHeight <= 0`, or
 *   `domainMin > domainMax`. `valueToPixel` returns `asPixel(0)` and
 *   `pixelToValue` returns the domain midpoint — callers must still check
 *   `valid` before trusting the output as visually correct.
 */
export class PriceScale {
  readonly domainMin: Price;
  readonly domainMax: Price;
  readonly pixelHeight: number;
  readonly margins: PriceScaleMargins;
  readonly valid: boolean;

  readonly effectiveMin: number;
  readonly effectiveMax: number;

  private readonly span: number;

  constructor(input: PriceScaleInput) {
    const rawMin = Number(input.domainMin);
    const rawMax = Number(input.domainMax);
    const pixelHeight = input.pixelHeight;
    const margins = resolveMargins(input.margins);

    this.domainMin = input.domainMin;
    this.domainMax = input.domainMax;
    this.pixelHeight = pixelHeight;
    this.margins = margins;

    const inputsValid =
      Number.isFinite(rawMin) &&
      Number.isFinite(rawMax) &&
      Number.isFinite(pixelHeight) &&
      pixelHeight > 0 &&
      rawMin <= rawMax;

    this.valid = inputsValid;
    if (!inputsValid) {
      this.effectiveMin = 0;
      this.effectiveMax = 1;
      this.span = 1;
      return;
    }

    const [inflatedMin, inflatedMax] = inflateIfFlat(rawMin, rawMax);
    const height = inflatedMax - inflatedMin;
    this.effectiveMin = inflatedMin - height * margins.bottom;
    this.effectiveMax = inflatedMax + height * margins.top;
    this.span = this.effectiveMax - this.effectiveMin;
  }

  valueToPixel(v: Price | number): Pixel {
    if (!this.valid || this.span <= 0) {
      return asPixel(0);
    }
    const raw = Number(v);
    const t = (this.effectiveMax - raw) / this.span;
    return asPixel(t * this.pixelHeight);
  }

  pixelToValue(p: Pixel | number): Price {
    if (!this.valid || this.pixelHeight <= 0) {
      return asPrice((this.effectiveMax + this.effectiveMin) / 2);
    }
    const raw = Number(p);
    const t = raw / this.pixelHeight;
    return asPrice(this.effectiveMax - t * this.span);
  }

  withDomain(min: Price, max: Price): PriceScale {
    if (min === this.domainMin && max === this.domainMax) {
      return this;
    }
    return new PriceScale({
      domainMin: min,
      domainMax: max,
      pixelHeight: this.pixelHeight,
      margins: this.margins,
    });
  }

  withPixelHeight(pixelHeight: number): PriceScale {
    if (pixelHeight === this.pixelHeight) {
      return this;
    }
    return new PriceScale({
      domainMin: this.domainMin,
      domainMax: this.domainMax,
      pixelHeight,
      margins: this.margins,
    });
  }
}

function resolveMargins(input: PriceScaleMargins | undefined): PriceScaleMargins {
  if (input === undefined) {
    return DEFAULT_PRICE_MARGINS;
  }
  const top = Number.isFinite(input.top) && input.top >= 0 ? input.top : DEFAULT_PRICE_MARGINS.top;
  const bottom =
    Number.isFinite(input.bottom) && input.bottom >= 0 ? input.bottom : DEFAULT_PRICE_MARGINS.bottom;
  return Object.freeze({ top, bottom });
}

function inflateIfFlat(min: number, max: number): readonly [number, number] {
  if (max > min) {
    return [min, max];
  }
  const magnitude = Math.abs(min);
  const delta = magnitude > 0 ? magnitude * ZERO_HEIGHT_INFLATE_FRACTION : ZERO_HEIGHT_INFLATE_MIN;
  return [min - delta, max + delta];
}
