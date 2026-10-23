import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Dev: `npm run dev` (port 5173) meneruskan /api, /agent, dan /lab ke server aplikasi di 4317.
const backend = process.env.AIOPS_BACKEND ?? 'http://localhost:4317';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: { port: 5173, proxy: { '/api': backend, '/agent': backend, '/lab': backend } },
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 600 },
  test: { environment: 'jsdom', globals: true, setupFiles: ['./src/test/setup.ts'], css: false, testTimeout: 60000 }   // CPU kontainer build lebih lambat dari mesin lokal; batas 5 dtk bawaan membuat tes UI yang banyak mengetik gagal acak
});
