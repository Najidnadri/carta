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
    include: ["src/**/*.test.ts"],
  },
}));
