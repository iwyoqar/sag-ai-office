import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Same-origin /api in dev so the session cookie stays first-party and httpOnly.
  server: { port: 5173, strictPort: true, proxy: { "/api": { target: "http://127.0.0.1:4000", changeOrigin: false } } },
  build: {
    chunkSizeWarningLimit: 900,
    rollupOptions: { output: { manualChunks: { three: ["three"] } } },
  },
  test: { environment: "node", include: ["test/**/*.test.ts"] },
});
