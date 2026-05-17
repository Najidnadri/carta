/**
 * Phase 15 Cycle C — minimal Promise wrappers for IndexedDB.
 *
 * IndexedDB's API is callback-based and has a hard rule (MDN): a
 * transaction is only active while the current task is running OR inside
 * a request `success`/`error` handler. You cannot `await` between two
 * `objectStore.X()` calls in the same transaction — Safari is the
 * strictest about this. The pattern is: fire all requests synchronously
 * (the implicit `await reqAsPromise` only triggers a microtask, which IDB
 * tolerates), then `await txAsPromise` once at the end to confirm commit.
 *
 * We also `await tx.complete` rather than `req.success` — the request
 * resolves before the durable commit. Old WebKit reverted writes when
 * the page unloaded between the two.
 */

export function reqAsPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.addEventListener("success", () => { resolve(req.result); });
    req.addEventListener("error", () => {
      reject(req.error ?? new DOMException("IDB request failed", "AbortError"));
    });
  });
}

export function txAsPromise(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.addEventListener("complete", () => { resolve(); });
    tx.addEventListener("error", () => {
      reject(tx.error ?? new DOMException("IDB transaction failed", "AbortError"));
    });
    tx.addEventListener("abort", () => {
      reject(tx.error ?? new DOMException("IDB transaction aborted", "AbortError"));
    });
  });
}
