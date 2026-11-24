import { defineConfig } from 'vite';

export default defineConfig({
  build: { outDir: 'dist/web', chunkSizeWarningLimit: 1024 },
  worker: { format: 'es' },
  server: { proxy: { '/api': `http://localhost:${process.env.API_PORT ?? 8080}` } },
});
