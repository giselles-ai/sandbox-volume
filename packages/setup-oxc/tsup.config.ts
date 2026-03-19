import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts"],
  outDir: "dist",
  format: ["esm"],
  clean: true,
  target: "node18",
  banner: {
    js: "#!/usr/bin/env node",
  },
});
