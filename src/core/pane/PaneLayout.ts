import type { PaneRect } from "./types.js";

export interface PaneLayoutInput {
  readonly stretchFactor: number;
  readonly minHeight: number;
  /**
   * Phase 14 Cycle A — when `true`, the pane is excluded from layout (rect
   * height = 0). Caller still receives a rect at the pane's index so the
   * chart's array-position bookkeeping remains aligned.
   */
  readonly hidden?: boolean;
  /**
   * Phase 14 Cycle A — pinned-height override. When set, this pane is
   * subtracted from `availableHeight` first; the remainder is distributed by
   * `stretchFactor` across the remaining flex panes.
   */
  readonly heightOverride?: number | null;
  /**
   * Phase 14 Cycle C — when `true`, the pane's plot region clamps to 0 px
   * but the header strip (if present) still renders. Distinct from
   * `hidden` (which removes the header too). Collapsed panes contribute
   * exactly `headerHeight` to the layout if they have a header, else 0.
   */
  readonly collapsed?: boolean;
  /**
   * Phase 14 Cycle C — header strip height for this pane. `0` (default)
   * means no header strip. Visible-or-collapsed panes with a header
   * reserve `headerHeight` above their plot region.
   */
  readonly headerHeight?: number;
}

export interface PaneLayoutOptions {
  /** CSS-px reserved at the bottom of the canvas for the time axis. */
  readonly bottomMargin: number;
  /** Hard floor for any pane's height; fallback when `pane.minHeight` < this. */
  readonly minHeight: number;
}

/**
 * Phase 14 Cycle C — output of `computePaneRects`. Each pane gets an
 * outer `outerRect` (full pane vertical band including the header strip)
 * and an inner `rect` (plot region, below the header strip). Cycle A+B
 * callers that only read `rect` continue to work unchanged.
 *
 * `headerRect` describes the header strip's pixel band; when the pane
 * has no header, `headerRect.h === 0`.
 */
export interface PaneRectBundle {
  readonly rect: PaneRect;
  readonly headerRect: PaneRect;
  readonly outerRect: PaneRect;
}

const HARD_MIN_HEIGHT = 30;

/**
 * Phase 14 Cycle A — pure layout function. Distributes a chart's available
 * vertical space across N panes by `stretchFactor`, then enforces per-pane
 * `minHeight`. Returns one `PaneRect` per input pane in top-to-bottom order.
 *
 * Phase 14 Cycle C extension — cycles A + B return `PaneRect[]`; cycle C
 * adds the parallel `computePaneRectBundles` function which returns the
 * full bundle (`rect` + `headerRect` + `outerRect`). The legacy
 * `computePaneRects` function is preserved by mapping `bundle.rect`
 * through. Existing call sites that only need the plot rect keep working.
 *
 * Conventions:
 *
 * - `availableHeight = chartHeight - bottomMargin - Σ headerHeight(visible-or-collapsed)`.
 *   Header strips are reserved BEFORE flex distribution so the plot region
 *   below each header lands at a stable Y regardless of stretch math.
 * - Each pane's effective `minHeight` is `max(input.minHeight, opts.minHeight,
 *   HARD_MIN_HEIGHT)`. The default bumps both the slot floor and the global
 *   floor to 50; below that, axis labels stop being legible.
 * - `Σ stretchFactor === 0` falls back to equal distribution. Same for any
 *   pane with non-finite or negative `stretchFactor` — sanitised to `0`,
 *   then the equal-distribution fallback kicks in if all panes are zero.
 * - Heights are rounded to integer pixels so pane frames + crosshair tags
 *   render crisp without sub-pixel blur. Rounding is cumulative — each pane's
 *   y is the previous pane's y + h, so the stack's total height stays exact.
 * - When `Σ minHeight > availableHeight`, panes overflow: each gets its
 *   minHeight and the layout extends past `availableHeight`. Cycle C's
 *   adaptive auto-collapse handles the overflow case at the chart level
 *   by hiding panes from the bottom up.
 * - Collapsed panes contribute exactly `headerHeight` (their plot region is
 *   0 px) — collapsed panes with `headerHeight === 0` contribute 0.
 *
 * Returns an empty array if `chartHeight` is non-finite, ≤ 0, or `panes.length === 0`.
 */
export function computePaneRects(
  chartWidth: number,
  chartHeight: number,
  panes: readonly PaneLayoutInput[],
  opts: PaneLayoutOptions,
): PaneRect[] {
  return computePaneRectBundles(chartWidth, chartHeight, panes, opts).map((b) => b.rect);
}

/**
 * Phase 14 Cycle C — bundled layout output. `rect` is the plot region
 * (below the header strip, mirrors the cycle A `PaneRect` shape).
 * `headerRect` is the header strip band (0-height when no header).
 * `outerRect` is the union of the two — the full pane band useful for
 * hit-testing the divider hover zone or capturing both at once.
 */
export function computePaneRectBundles(
  chartWidth: number,
  chartHeight: number,
  panes: readonly PaneLayoutInput[],
  opts: PaneLayoutOptions,
): PaneRectBundle[] {
  if (
    !Number.isFinite(chartWidth) ||
    !Number.isFinite(chartHeight) ||
    chartWidth <= 0 ||
    chartHeight <= 0 ||
    panes.length === 0
  ) {
    return [];
  }

  const safeChartW = Math.max(0, Math.floor(chartWidth));
  const safeChartH = Math.max(0, Math.floor(chartHeight));

  // Phase 14 Cycle C — sanitize per-pane header height. Hidden panes
  // contribute 0 (no header reserved); collapsed AND visible panes both
  // reserve their declared height.
  const headerH = panes.map((p) => {
    if (p.hidden === true) {
      return 0;
    }
    const raw = p.headerHeight;
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
      return 0;
    }
    return Math.max(0, Math.floor(raw));
  });
  const headerTotal = headerH.reduce((acc, n) => acc + n, 0);

  const availableHeight = Math.max(
    0,
    safeChartH - Math.max(0, opts.bottomMargin) - headerTotal,
  );

  const globalMin = Math.max(HARD_MIN_HEIGHT, Math.max(0, opts.minHeight));
  const effMins = panes.map((p) => {
    if (p.hidden === true) {
      return 0;
    }
    if (p.collapsed === true) {
      return 0; // plot region clamps to 0 px when collapsed
    }
    const raw = Number.isFinite(p.minHeight) ? p.minHeight : globalMin;
    return Math.max(globalMin, Math.max(HARD_MIN_HEIGHT, Math.floor(raw)));
  });

  // Phase 14 Cycle A — pinned heights are subtracted from `availableHeight`
  // first; the remainder is distributed by stretchFactor across non-hidden,
  // non-pinned, non-collapsed panes. Hidden + collapsed panes contribute 0
  // to the plot allocation (collapsed still gets its `headerH` reserved).
  const allocated: number[] = panes.map(() => 0);
  let pinnedTotal = 0;
  for (let i = 0; i < panes.length; i += 1) {
    const p = panes[i];
    if (p === undefined) {
      continue;
    }
    if (p.hidden === true || p.collapsed === true) {
      continue;
    }
    if (typeof p.heightOverride === "number" && Number.isFinite(p.heightOverride) && p.heightOverride > 0) {
      const min = effMins[i] ?? globalMin;
      const h = Math.max(min, Math.floor(p.heightOverride));
      allocated[i] = h;
      pinnedTotal += h;
    }
  }
  const flexAvail = Math.max(0, availableHeight - pinnedTotal);

  const factors = panes.map((p) => {
    if (p.hidden === true || p.collapsed === true) {
      return 0;
    }
    if (typeof p.heightOverride === "number" && Number.isFinite(p.heightOverride) && p.heightOverride > 0) {
      return 0; // pinned, not flex
    }
    return Number.isFinite(p.stretchFactor) && p.stretchFactor > 0 ? p.stretchFactor : 0;
  });
  const factorSum = factors.reduce((acc, n) => acc + n, 0);
  // When `Σ stretchFactor === 0` we fall back to equal distribution across
  // every non-hidden, non-pinned, non-collapsed pane.
  const equalCount = panes.filter(
    (p) =>
      p.hidden !== true &&
      p.collapsed !== true &&
      !(typeof p.heightOverride === "number" && Number.isFinite(p.heightOverride) && p.heightOverride > 0),
  ).length;
  const useEqual = factorSum <= 0 && equalCount > 0;

  // Step 1 — initial flex distribution.
  for (let i = 0; i < panes.length; i += 1) {
    const p = panes[i];
    if (p === undefined || p.hidden === true || p.collapsed === true) {
      continue;
    }
    if (typeof p.heightOverride === "number" && Number.isFinite(p.heightOverride) && p.heightOverride > 0) {
      continue;
    }
    if (useEqual) {
      allocated[i] = flexAvail / equalCount;
    } else if (factorSum > 0) {
      allocated[i] = ((factors[i] ?? 0) / factorSum) * flexAvail;
    } else {
      allocated[i] = 0;
    }
  }

  // Step 2 — enforce minHeight per non-hidden, non-collapsed pane.
  // Steal from largest flex pane.
  for (let i = 0; i < allocated.length; i += 1) {
    const p = panes[i];
    if (p === undefined || p.hidden === true || p.collapsed === true) {
      continue;
    }
    const min = effMins[i] ?? globalMin;
    if ((allocated[i] ?? 0) < min) {
      const deficit = min - (allocated[i] ?? 0);
      allocated[i] = min;
      let donor = -1;
      let donorSlack = 0;
      for (let j = 0; j < allocated.length; j += 1) {
        if (j === i) {
          continue;
        }
        const pj = panes[j];
        if (pj === undefined || pj.hidden === true || pj.collapsed === true) {
          continue;
        }
        const jMin = effMins[j] ?? globalMin;
        const slack = (allocated[j] ?? 0) - jMin;
        if (slack > donorSlack) {
          donorSlack = slack;
          donor = j;
        }
      }
      if (donor !== -1) {
        const take = Math.min(deficit, donorSlack);
        allocated[donor] = (allocated[donor] ?? 0) - take;
      }
    }
  }

  // Step 3 — integer-pixel rounding, cumulative so total stays exact.
  // Cycle C — each pane occupies headerH(i) + allocated(i) consecutive px.
  const bundles: PaneRectBundle[] = [];
  let cursorY = 0;
  let cumulativeIdeal = 0;
  for (let i = 0; i < allocated.length; i += 1) {
    const hThisPaneHeader = headerH[i] ?? 0;
    cumulativeIdeal += hThisPaneHeader + (allocated[i] ?? 0);
    const nextY = Math.round(cumulativeIdeal);
    const totalH = Math.max(0, nextY - cursorY);
    const headerHi = Math.min(hThisPaneHeader, totalH);
    const plotHi = Math.max(0, totalH - headerHi);
    const headerRect: PaneRect = {
      x: 0,
      y: cursorY,
      w: safeChartW,
      h: headerHi,
    };
    const rect: PaneRect = {
      x: 0,
      y: cursorY + headerHi,
      w: safeChartW,
      h: plotHi,
    };
    const outerRect: PaneRect = {
      x: 0,
      y: cursorY,
      w: safeChartW,
      h: totalH,
    };
    bundles.push({ rect, headerRect, outerRect });
    cursorY = nextY;
  }
  return bundles;
}
