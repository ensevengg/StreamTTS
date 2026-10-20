import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

// https://vitejs.dev/config/
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/test/setup.ts'],
  },
  server: {
    // Loopback only: the dev server serves project files (including .env),
    // so it must not be reachable from the local network.
    host: "localhost",
    // Tauri's devUrl expects exactly this port; fail instead of moving.
    port: 8080,
    strictPort: true,
    hmr: {
      overlay: false
    }
  },
  plugins: [
    react()
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  // Relative asset paths so the bundle loads from Tauri's custom protocol.
  base: "./",
  build: {
    sourcemap: process.env.NODE_ENV === 'development',
    target: 'es2020',
  },
});
