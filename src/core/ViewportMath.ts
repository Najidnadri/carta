import { asTime, type Interval, type Time } from "../types.js";

export interface WindowSnapshot {
  readonly startTime: Time;
  readonly endTime: Time;
  readonly intervalDuration: Interval;
}

export interface ResultWindow {
  readonly startTime: Time;
  readonly endTime: Time;
}

export interface ClampOptions {
  readonly minIntervalDuration?: number | undefined;
  readonly maxWindowDuration?: number | undefined;
}

function isValidSnapshot(snap: WindowSnapshot): boolean {
  const start = Number(snap.startTime);
  const end = Number(snap.endTime);
  const interval = Number(snap.intervalDuration);
  return (
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    Number.isFinite(interval) &&
    interval > 0 &&
    start <= end
  );
}

function snapshotToWindow(snap: WindowSnapshot): ResultWindow {
  return { startTime: snap.startTime, endTime: snap.endTime };
}

/**
 * Shift the window by `dxPx` across a plot of `plotWidthPx`. Positive `dxPx`
 * (drag right) shifts the window to earlier times. Width is preserved.
 * Degenerate inputs return the snapshot unchanged.
 */
export function computePannedWindow(
  snap: WindowSnapshot,
  dxPx: number,
  plotWidthPx: number,
): ResultWindow {
  if (!isValidSnapshot(snap) || !Number.isFinite(dxPx) || !Number.isFinite(plotWidthPx) || plotWidthPx <= 0) {
    return snapshotToWindow(snap);
  }
  const start = Number(snap.startTime);
  const end = Number(snap.endTime);
  const spanMs = end - start;
  if (spanMs === 0) {
    return snapshotToWindow(snap);
  }
  const dtPerPx = spanMs / plotWidthPx;
  const shiftMs = -dxPx * dtPerPx;
  return {
    startTime: asTime(start + shiftMs),
    endTime: asTime(end + shiftMs),
  };
}

/**
 * Zoom around an anchor time by `factor` (<1 zooms in, >1 zooms out).
 * Computes in relative-offset arithmetic (`anchorOffset = anchorTime -
 * startTime`) to preserve float precision at large epochs.
 *
 * Width is clamped to `[minIntervalDuration, maxWindowDuration ?? Infinity]`.
 * When clamping triggers, the anchor keeps its proportional position under
 * the cursor — so the cursor stays on the same time.
 */
export function computeZoomedWindow(
  snap: WindowSnapshot,
  anchorTime: Time,
  factor: number,
  clamp: ClampOptions = {},
): ResultWindow {
  if (!isValidSnapshot(snap) || !Number.isFinite(Number(anchorTime)) || !Number.isFinite(factor) || factor <= 0) {
    return snapshotToWindow(snap);
  }
  const start = Number(snap.startTime);
  const end = Number(snap.endTime);
  const duration = end - start;
  if (duration <= 0) {
    return snapshotToWindow(snap);
  }

  const minWidth = Math.max(
    Number(snap.intervalDuration),
    clamp.minIntervalDuration !== undefined && Number.isFinite(clamp.minIntervalDuration) && clamp.minIntervalDuration > 0
      ? clamp.minIntervalDuration
      : 0,
  );
  const maxWidth =
    clamp.maxWindowDuration !== undefined && Number.isFinite(clamp.maxWindowDuration) && clamp.maxWindowDuration > 0
      ? clamp.maxWindowDuration
      : Number.POSITIVE_INFINITY;

  const anchorOffset = Number(anchorTime) - start;
  const clampedAnchorOffset = Math.max(0, Math.min(duration, anchorOffset));
  const proportion = duration === 0 ? 0 : clampedAnchorOffset / duration;

  let newDuration = duration * factor;
  if (newDuration < minWidth) {
    newDuration = minWidth;
  } else if (newDuration > maxWidth) {
    newDuration = maxWidth;
  }

  const newStart = start + clampedAnchorOffset - newDuration * proportion;
  const newEnd = newStart + newDuration;
  return {
    startTime: asTime(newStart),
    endTime: asTime(newEnd),
  };
}

/**
 * Fixed-fraction horizontal pan (used by Shift+wheel). `direction` is -1 or
 * +1; a positive direction shifts the window to later times by `fraction` of
 * the current window width.
 */
export function computeShiftPannedWindow(
  snap: WindowSnapshot,
  direction: number,
  fraction: number,
): ResultWindow {
  if (!isValidSnapshot(snap) || !Number.isFinite(direction) || !Number.isFinite(fraction)) {
    return snapshotToWindow(snap);
  }
  const start = Number(snap.startTime);
  const end = Number(snap.endTime);
  const spanMs = end - start;
  if (spanMs <= 0) {
    return snapshotToWindow(snap);
  }
  const shift = Math.sign(direction) * fraction * spanMs;
  return {
    startTime: asTime(start + shift),
    endTime: asTime(end + shift),
  };
}

/**
 * Normalise a raw `WheelEvent.deltaY` by `deltaMode` to approximate pixels.
 * Sign-gated zoom doesn't need this; kept for future proportional-zoom modes.
 */
export function normalizeWheelDelta(deltaY: number, deltaMode: number): number {
  if (!Number.isFinite(deltaY)) {
    return 0;
  }
  const LINE_HEIGHT_PX = 16;
  const PAGE_HEIGHT_PX = 800;
  if (deltaMode === 1) {
    return deltaY * LINE_HEIGHT_PX;
  }
  if (deltaMode === 2) {
    return deltaY * PAGE_HEIGHT_PX;
  }
  return deltaY;
}

/** Validate and, if needed, coerce a proposed window to the legal snapshot. */
export function sanitizeWindow(
  proposal: { startTime: Time; endTime: Time },
  snap: WindowSnapshot,
): ResultWindow {
  const start = Number(proposal.startTime);
  const end = Number(proposal.endTime);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return snapshotToWindow(snap);
  }
  return { startTime: asTime(start), endTime: asTime(end) };
}
