import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root,
  plugins: [vue()],
  build: {
    outDir: path.join(root, 'dist'),
    emptyOutDir: true
  },
  server: {
    port: 14771,
    proxy: {
      '/api': 'http://127.0.0.1:14770',
      '/sub': 'http://127.0.0.1:14770'
    }
  }
});
