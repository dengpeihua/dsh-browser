import { defineConfig } from "tsdown"

export default defineConfig({
  entry: ["src/index.ts"],
  outDir: "lib",
  format: ["esm"],
  fixedExtension: false,
  dts: true,
  sourcemap: true,
  clean: true,
  deps: {
    neverBundle: [/^@deepseek-ai\//, "puppeteer-core"],
  },
})
