/**
 * Phase 15 Cycle B — typed wrapper around `lz-string`. The compression
 * library's d.ts surface is fine but boxing it here keeps the import in one
 * place so `oxlint --type-aware` doesn't need to chase it across modules,
 * and isolates the only Carta dep on a third-party compressor.
 *
 * `compressToEncodedURIComponent` and `decompressFromEncodedURIComponent`
 * produce/consume strings that are safe to drop into a URL fragment without
 * a further `encodeURIComponent` pass (output alphabet is
 * `[A-Za-z0-9+\-$_]`). `decompress` returns `null` on malformed input,
 * which the permalink decoder maps to `CartaSchemaError`.
 */

import {
  compressToEncodedURIComponent,
  decompressFromEncodedURIComponent,
} from "lz-string";

export function lzEncode(input: string): string {
  return compressToEncodedURIComponent(input);
}

export function lzDecode(input: string): string | null {
  // lz-string's bundled d.ts narrows the return to `string`, but at runtime
  // the decompressor produces `null` for malformed input (e.g.,
  // `decompressFromEncodedURIComponent('!!!notvalidlz!!!') === null`). Without
  // this check, downstream `out.length` access throws `TypeError` — caught
  // by phase-15 cycle-B test `adv-perm-tier2-mangled-body`. We funnel the
  // value through `unknown` so the runtime `typeof` narrow satisfies the
  // type-aware lint without re-introducing the unchecked-null bug.
  const raw: unknown = decompressFromEncodedURIComponent(input);
  if (typeof raw !== "string" || raw.length === 0) {
    return null;
  }
  return raw;
}
