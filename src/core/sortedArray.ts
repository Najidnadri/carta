/**
 * Smallest useful binary-search helpers shared by `IntervalCache` and
 * (potentially) other sorted-array consumers. Zero-dep, tree-shakeable.
 */

/**
 * Returns the first index `i` such that `arr[i] >= target`. If every element
 * is `< target`, returns `arr.length`. Equivalent to C++'s `std::lower_bound`.
 */
export function lowerBound(arr: readonly number[], target: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((arr[mid] as number) < target) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/**
 * Returns the first index `i` such that `arr[i] > target`. If every element
 * is `<= target`, returns `arr.length`. Equivalent to C++'s `std::upper_bound`.
 */
export function upperBound(arr: readonly number[], target: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((arr[mid] as number) <= target) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/** Whether `arr` is ascending (non-strict). Early-bails on the first violation. */
export function isAscending(arr: readonly number[]): boolean {
  for (let i = 1; i < arr.length; i++) {
    if ((arr[i - 1] as number) > (arr[i] as number)) {
      return false;
    }
  }
  return true;
}
