/// <reference types="vitest" />
import { defineConfig } from "vite";
import { resolve } from "node:path";
import dts from "vite-plugin-dts";

const isTest = process.env.VITEST === "true";

export default defineConfig(({ command }) => ({
  ...(command === "serve" && !isTest ? { root: "demo" } : {}),
  build: {
    outDir: resolve(__dirname, "dist"),
    emptyOutDir: true,
    sourcemap: true,
    lib: {
      entry: resolve(__dirname, "src/index.ts"),
      name: "Carta",
      formats: ["es", "cjs"],
      fileName: (format) => (format === "es" ? "carta.js" : "carta.cjs"),
    },
    rollupOptions: {
      external: ["pixi.js"],
      output: {
        globals: { "pixi.js": "PIXI" },
      },
    },
  },
  plugins: [
    dts({
      include: ["src"],
      rollupTypes: true,
      insertTypesEntry: true,
    }),
  ],
  server: {
    port: 5173,
    open: true,
  },
  test: {
    globals: true,
    environment: "jsdom",
    include: ["src/**/*.test.ts", "demo/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/index.ts",
        "src/types.ts",
        "src/core/render/**",
        "src/core/series/**",
        "src/core/overlays/**",
        "src/core/interaction/**",
        "src/core/chart/PixiRenderer.ts",
        "src/core/chart/TimeSeriesChart.ts",
        "src/core/chart/Chart.ts",
        "src/core/price/PriceAxis.ts",
        "src/core/price/PriceAxisController.ts",
        "src/core/time/TimeAxis.ts",
        "src/core/viewport/ViewportController.ts",
      ],
      thresholds: {
        perFile: true,
        "src/core/data/**": { lines: 80, branches: 75 },
        "src/core/price/**": { lines: 80, branches: 75 },
        "src/core/viewport/**": { lines: 80, branches: 75 },
        "src/core/infra/**": { lines: 80, branches: 75 },
        "src/core/time/**": { lines: 80, branches: 75 },
      },
    },
  },
}));
