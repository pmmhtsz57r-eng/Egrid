import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 650, // three.js alone is about 600 kB (148 kB gzipped)
    // three.js and React change rarely: separate chunks cache across releases
    rollupOptions: { output: { manualChunks: (id: string) => (id.includes('node_modules/three') ? 'three' : id.includes('node_modules/react') ? 'react' : undefined) } },
  },
  test: { include: ['tests/**/*.test.ts'] },
} as never);
