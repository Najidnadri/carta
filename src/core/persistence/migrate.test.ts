import { describe, it, expect } from "vitest";
import { migrate } from "./migrate.js";
import { CARTA_SCHEMA_VERSION, CartaSchemaError } from "./types.js";

const validState = (): unknown => ({
  schemaVersion: CARTA_SCHEMA_VERSION,
  savedAt: "2026-05-17T00:00:00.000Z",
  window: { startTime: 0, endTime: 1000 },
  intervalDuration: 60000,
  chartType: "candle",
  primaryChannelId: "primary",
  series: [],
});

describe("migrate — happy path", () => {
  it("identity-migrates a v1 state", () => {
    const out = migrate(validState());
    expect(out.schemaVersion).toBe(CARTA_SCHEMA_VERSION);
    expect(out.intervalDuration).toBe(60000);
    expect(out.window.startTime).toBe(0);
    expect(out.window.endTime).toBe(1000);
  });

  it("preserves optional fields", () => {
    const v = validState() as Record<string, unknown>;
    v["theme"] = { name: "dark", overrides: { background: 0x111111 } };
    v["primarySymbol"] = "AAPL";
    const out = migrate(v);
    expect(out.theme?.name).toBe("dark");
    expect(out.primarySymbol).toBe("AAPL");
  });
});

describe("migrate — error matrix", () => {
  it("rejects null", () => {
    expect(() => migrate(null)).toThrowError(CartaSchemaError);
  });
  it("rejects array", () => {
    expect(() => migrate([])).toThrowError(CartaSchemaError);
  });
  it("rejects string", () => {
    expect(() => migrate("not a state")).toThrowError(CartaSchemaError);
  });
  it("rejects missing schemaVersion", () => {
    expect(() => migrate({ savedAt: "x" })).toThrowError(CartaSchemaError);
  });
  it("rejects future schemaVersion", () => {
    expect(() => migrate({ ...(validState() as object), schemaVersion: 99 })).toThrowError(
      CartaSchemaError,
    );
  });
  it("rejects negative schemaVersion", () => {
    expect(() => migrate({ ...(validState() as object), schemaVersion: -1 })).toThrowError(
      CartaSchemaError,
    );
  });
  it("rejects non-integer schemaVersion", () => {
    expect(() => migrate({ ...(validState() as object), schemaVersion: 1.5 })).toThrowError(
      CartaSchemaError,
    );
  });
  it("rejects v0 (no migrator registered)", () => {
    expect(() => migrate({ ...(validState() as object), schemaVersion: 0 })).toThrowError(
      /no migrator registered/,
    );
  });
  it("rejects v1 state with bad payload", () => {
    expect(() =>
      migrate({ ...(validState() as object), intervalDuration: -1 }),
    ).toThrowError(CartaSchemaError);
  });
});
