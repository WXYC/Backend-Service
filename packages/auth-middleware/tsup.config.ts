import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["index.ts"],
  outDir: "dist",
  format: ["esm"],
  clean: true,
  sourcemap: true,
  external: ["@wxyc/shared"],
  env: {
    NODE_ENV: process.env.NODE_ENV || "development",
  },
});
