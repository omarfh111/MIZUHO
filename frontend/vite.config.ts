import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react(), {
      name: 'mizuho-localized-jsx',
      enforce: 'post',
      // Prebundle React itself. Compile application JSX against the editable local runtime
      // so the selector and localized components share one context in development too.
      config: () => ({ esbuild: { jsxImportSource: '@mizuho/i18n' } }),
    }],
    optimizeDeps: { exclude: ['@mizuho/i18n'] },
    resolve: {
      alias: { '@mizuho/i18n': fileURLToPath(new URL('./src/i18n', import.meta.url)) },
      dedupe: ['react', 'react-dom', 'three'],
    },
    server: { proxy: { '/api': { target: env.MIZU_API_TARGET || 'http://127.0.0.1:8000', ws: true } } },
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (/\/src\/i18n\/tunisian(Messages|Patterns)\.ts$/.test(id)) return 'tunisian-messages';
            if (/\/src\/i18n\/(common|explore|planning)\.ts$/.test(id)) return 'japanese-messages';
            if (id.endsWith('/three/build/three.core.js')) return 'three-core';
            if (id.includes('/node_modules/three/')) return 'three-renderer';
          },
        },
      },
    },
  };
});
