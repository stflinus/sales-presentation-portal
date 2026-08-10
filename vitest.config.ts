import { defineConfig } from "vitest/config";
import path from "node:path";

const root = import.meta.dirname;

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 60000,
    hookTimeout: 120000,
  },
  resolve: {
    alias: {
      "@spp/shared": path.resolve(root, "packages/shared/src/index.ts"),
    },
  },
});
