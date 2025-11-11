import { defineConfig } from "tsup";

export default defineConfig((options) => ({
  entry: ["app.ts"],
  outDir: "dist",
  format: ["esm"],
  clean: true,
  sourcemap: true,
  external: ["@wxyc/database"],
  env: {
    NODE_ENV: process.env.NODE_ENV || "development",
  },
  onSuccess: options.watch ? "node ./dist/app.js" : undefined,
}));