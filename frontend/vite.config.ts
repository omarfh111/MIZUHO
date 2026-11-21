import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react()],
    server: { proxy: { '/api': env.MIZU_API_TARGET || 'http://127.0.0.1:8000' } },
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.endsWith('/three/build/three.core.js')) return 'three-core';
            if (id.includes('/node_modules/three/')) return 'three-renderer';
          },
        },
      },
    },
  };
});
