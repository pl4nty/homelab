import { defineConfig } from 'vite';

export default defineConfig({
  // Shiki grammars load on demand as separate chunks
  build: { chunkSizeWarningLimit: 1024 },
});
