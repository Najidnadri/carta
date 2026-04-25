import type { Interval, Theme, Time } from "../../types.js";

export interface ConfigStateSnapshot {
  readonly startTime: Time;
  readonly endTime: Time;
  readonly intervalDuration: Interval;
  readonly width: number;
  readonly height: number;
  readonly theme: Theme;
}

/**
 * Immutable config snapshot. Each `with*` mutator returns a new `ConfigState`
 * when the values differ, or `this` when they don't — callers can rely on
 * identity checks (`prev === next`) to skip work.
 */
export class ConfigState {
  readonly snapshot: ConfigStateSnapshot;

  constructor(initial: ConfigStateSnapshot) {
    this.snapshot = Object.freeze({ ...initial });
  }

  withWindow(startTime: Time, endTime: Time): ConfigState {
    if (startTime === this.snapshot.startTime && endTime === this.snapshot.endTime) {
      return this;
    }
    return new ConfigState({ ...this.snapshot, startTime, endTime });
  }

  withInterval(intervalDuration: Interval): ConfigState {
    if (intervalDuration === this.snapshot.intervalDuration) {
      return this;
    }
    return new ConfigState({ ...this.snapshot, intervalDuration });
  }

  withSize(width: number, height: number): ConfigState {
    if (width === this.snapshot.width && height === this.snapshot.height) {
      return this;
    }
    return new ConfigState({ ...this.snapshot, width, height });
  }

  withTheme(theme: Theme): ConfigState {
    if (theme === this.snapshot.theme) {
      return this;
    }
    return new ConfigState({ ...this.snapshot, theme });
  }
}
