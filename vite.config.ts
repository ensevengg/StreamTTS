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
  base: "./",
  build: {
    // Use source maps only in development mode
    sourcemap: process.env.NODE_ENV === 'development',
    // Optimize module chunks for faster loading
    rollupOptions: {
      output: {
        manualChunks: {
          // Core React chunks
          'react-vendor': ['react', 'react-dom'],
          'react-router': ['react-router-dom'],
          
          // UI Library chunks
          'radix-core': [
            '@radix-ui/react-slider',
            '@radix-ui/react-select',
            '@radix-ui/react-switch',
            '@radix-ui/react-tabs',
          ],
          
          // Utility chunks
          'ui-utils': ['lucide-react', 'sonner', 'tailwind-merge', 'class-variance-authority'],
          'form-utils': ['zod'],
          'query-utils': ['@tanstack/react-query'],
          
          // Chat/Stream specific
          'stream-utils': ['tmi.js'],
        },
        // Minimize chunk size and improve loading
        chunkFileNames: (chunkInfo) => {
          // Use shorter names for faster loading
          return `js/[name]-[hash:8].js`;
        },
        entryFileNames: 'js/[name]-[hash:8].js',
        assetFileNames: (assetInfo) => {
          if (assetInfo.name?.endsWith('.css')) {
            return 'css/[name]-[hash:8].css';
          }
          return 'assets/[name]-[hash:8][extname]';
        }
      }
    },
    // Advanced minification for smaller bundle size
    minify: process.env.NODE_ENV === 'production' ? 'terser' : false,
    terserOptions: {
      compress: {
        passes: 3, // Multiple passes for better compression
        drop_console: process.env.NODE_ENV === 'production',
        drop_debugger: true,
        pure_funcs: ['console.log', 'console.info', 'console.debug'],
        dead_code: true,
        unused: true
      },
      mangle: {
        safari10: true
      },
      format: {
        comments: false
      }
    },
    // Optimize CSS
    cssMinify: true,
    // Reduce chunk size warning threshold
    chunkSizeWarningLimit: 800,
    // Enable aggressive optimization
    target: 'es2020',
    // Optimize asset handling
    assetsInlineLimit: 4096,
    // Improve build performance
    reportCompressedSize: false
  },
  // Advanced dependency optimization
  optimizeDeps: {
    include: [
      'react',
      'react-dom',
      'react-router-dom',
      '@tanstack/react-query',
      'lucide-react',
      'tmi.js',
      'sonner',
      'tailwind-merge',
      'class-variance-authority'
    ],
    exclude: ['@vite/client', '@vite/env'],
    esbuildOptions: {
      target: 'es2020',
      supported: {
        'top-level-await': true
      }
    }
  }
});
