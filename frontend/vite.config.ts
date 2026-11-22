import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react(), {
      name: 'mizhuo-localized-jsx',
      enforce: 'post',
      // Prebundle React itself. Compile application JSX against the editable local runtime
      // so the selector and localized components share one context in development too.
      config: () => ({ esbuild: { jsxImportSource: '@mizhuo/i18n' } }),
    }],
    optimizeDeps: { exclude: ['@mizhuo/i18n'] },
    resolve: {
      alias: { '@mizhuo/i18n': fileURLToPath(new URL('./src/i18n', import.meta.url)) },
      dedupe: ['react', 'react-dom', 'three'],
    },
    server: { proxy: { '/api': env.MIZU_API_TARGET || 'http://127.0.0.1:8000' } },
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (/\/src\/i18n\/(common|explore|planning)\.ts$/.test(id)) return 'japanese-messages';
            if (id.endsWith('/three/build/three.core.js')) return 'three-core';
            if (id.includes('/node_modules/three/')) return 'three-renderer';
          },
        },
      },
    },
  };
});
