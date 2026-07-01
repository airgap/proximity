import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// Resolve @proximity/* workspace packages straight to their TS source so Vite transpiles them
// as part of the app (no separate build step in dev).
const pkg = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@proximity/protocol": pkg("../../packages/protocol/src/index.ts"),
      "@proximity/spatial": pkg("../../packages/spatial/src/index.ts"),
      "@proximity/config": pkg("../../packages/config/src/index.ts"),
    },
  },
  server: {
    port: 5173,
    // Proxy the world-server WS through Vite in dev so the client can use a same-origin URL.
    proxy: {
      "/ws": {
        target: "ws://localhost:8080",
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
