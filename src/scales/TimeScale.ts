import { LinearScale } from "./LinearScale.js";

export class TimeScale extends LinearScale {
  setTimeDomain(startMs: number, endMs: number): this {
    return this.setDomain(startMs, endMs);
  }
}
