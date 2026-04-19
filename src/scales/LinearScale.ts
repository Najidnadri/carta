import type { Range } from "../types.js";

export class LinearScale {
  private domainMin = 0;
  private domainMax = 1;
  private rangeMin = 0;
  private rangeMax = 1;

  setDomain(min: number, max: number): this {
    this.domainMin = min;
    this.domainMax = max;
    return this;
  }

  setRange(min: number, max: number): this {
    this.rangeMin = min;
    this.rangeMax = max;
    return this;
  }

  toPixel(value: number): number {
    const t = (value - this.domainMin) / (this.domainMax - this.domainMin);
    return this.rangeMin + t * (this.rangeMax - this.rangeMin);
  }

  toValue(pixel: number): number {
    const t = (pixel - this.rangeMin) / (this.rangeMax - this.rangeMin);
    return this.domainMin + t * (this.domainMax - this.domainMin);
  }

  get domain(): Range {
    return { min: this.domainMin, max: this.domainMax };
  }
}
