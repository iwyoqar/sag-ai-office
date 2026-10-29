import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Same-origin /api in dev so the session cookie stays first-party and httpOnly.
  // WEB_PORT / API_TARGET let a second, isolated stack run next to the normal dev servers (e.g. demo data).
  server: {
    port: Number(process.env.WEB_PORT ?? 5173),
    strictPort: true,
    proxy: { "/api": { target: process.env.API_TARGET ?? "http://127.0.0.1:4000", changeOrigin: false } },
  },
  build: {
    chunkSizeWarningLimit: 900,
    rollupOptions: { output: { manualChunks: { three: ["three"] } } },
  },
  test: { environment: "node", include: ["test/**/*.test.ts"] },
});
