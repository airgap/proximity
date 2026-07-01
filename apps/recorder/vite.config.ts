import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@proximity/protocol": fileURLToPath(
        new URL("../../packages/protocol/src/index.ts", import.meta.url),
      ),
    },
  },
  server: { port: 5180 },
});
