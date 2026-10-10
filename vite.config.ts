import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.join(root, 'src/renderer'),
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': path.join(root, 'src/shared'),
      '@core': path.join(root, 'src/core'),
      '@renderer': path.join(root, 'src/renderer'),
    },
  },
  build: {
    outDir: path.join(root, 'dist/renderer'),
    emptyOutDir: true,
    target: 'chrome120',
    chunkSizeWarningLimit: 4096,
  },
  optimizeDeps: {
    include: ['pdfjs-dist'],
  },
  server: {
    port: 5173,
    strictPort: false,
  },
});
