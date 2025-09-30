import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["client.ts", "schema.ts"],
  outDir: "dist",
  format: ["esm"],
  clean: true,
  sourcemap: true,
  dts: true,
  env: {
    NODE_ENV: process.env.NODE_ENV || "development",
  },
});
