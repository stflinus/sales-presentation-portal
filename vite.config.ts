import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const root = import.meta.dirname;

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(root, "src"),
      "@spp/shared": path.resolve(root, "packages/shared/src/index.ts"),
    },
  },
  server: {
    port: 5173,
  },
});

