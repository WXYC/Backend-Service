import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["app.ts"],
  outDir: "dist",
  format: ["esm"],
  clean: true,
  sourcemap: true,
  external: ["@wxyc/database", "@wxyc/shared", "@wxyc/auth-middleware"],
  loader: {
    '.yaml': 'text',
  },
  env: {
    NODE_ENV: process.env.NODE_ENV || "development",
  },
  dts: false,
  target: "es2020",
  platform: "node",
  bundle: true,
  splitting: false,
  treeshake: true,
  publicDir: false,
  copy: [
    {
      from: "app.yaml",
      to: "app.yaml"
    }
  ]
});
