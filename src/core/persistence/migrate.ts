/**
 * Phase 15 Cycle A — chained-migrator scaffold. Cycle A ships only the
 * identity case (schemaVersion === 1). Future cycles append migrators
 * keyed by source version: `migrations[0]` migrates v0 → v1, etc.
 *
 * The migrator chain walks `schemaVersion` upward until it equals
 * `CARTA_SCHEMA_VERSION`. Unknown source versions (no migrator registered)
 * throw `CartaSchemaError` — hosts get an explicit signal rather than a
 * silent partial load.
 */

import {
  CARTA_SCHEMA_VERSION,
  CartaSchemaError,
  type ChartSaveState,
} from "./types.js";
import { isChartSaveState } from "./validate.js";

type Migrator = (input: Record<string, unknown>) => Record<string, unknown>;

const migrations: Readonly<Record<number, Migrator>> = Object.freeze({
  // 0: (s) => ({ ...s, schemaVersion: 1 }),  // example for future
});

/**
 * Walk `input` from its declared `schemaVersion` up to
 * `CARTA_SCHEMA_VERSION`, applying registered migrators in order. Throws
 * `CartaSchemaError` on:
 *   - non-object input;
 *   - missing or non-numeric `schemaVersion`;
 *   - schemaVersion higher than the current build's version (future format);
 *   - unregistered migrator at any intermediate version;
 *   - final shape failing `isChartSaveState`.
 */
export function migrate(input: unknown): ChartSaveState {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new CartaSchemaError("[carta] migrate: input is not an object");
  }
  const record = { ...(input as Record<string, unknown>) };
  const rawVersion = record["schemaVersion"];
  if (typeof rawVersion !== "number" || !Number.isInteger(rawVersion) || rawVersion < 0) {
    throw new CartaSchemaError(
      `[carta] migrate: schemaVersion must be a non-negative integer, got ${String(rawVersion)}`,
    );
  }
  if (rawVersion > CARTA_SCHEMA_VERSION) {
    throw new CartaSchemaError(
      `[carta] migrate: input schemaVersion ${String(rawVersion)} is newer than this build's ${String(CARTA_SCHEMA_VERSION)} — upgrade Carta to load this state`,
    );
  }
  let cursor = record;
  let v = rawVersion;
  while (v < CARTA_SCHEMA_VERSION) {
    const migrator = migrations[v];
    if (migrator === undefined) {
      throw new CartaSchemaError(
        `[carta] migrate: no migrator registered for schemaVersion ${String(v)} → ${String(v + 1)}`,
      );
    }
    cursor = migrator(cursor);
    v += 1;
    cursor["schemaVersion"] = v;
  }
  if (!isChartSaveState(cursor)) {
    throw new CartaSchemaError(
      "[carta] migrate: migrated state failed schema validation — payload is malformed",
    );
  }
  return cursor;
}
