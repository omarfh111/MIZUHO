import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The experience lives in ../src/experience so it can ship inside M7's app untouched.
// `dedupe` resolves its bare imports from this harness's node_modules.
export default defineConfig({
  plugins: [react()],
  resolve: {
    dedupe: [
      'react', 'react-dom', 'three', 'gsap', '@react-three/fiber', '@react-three/drei',
      '@react-three/postprocessing', 'postprocessing', '@fontsource-variable/space-grotesk', '@fontsource-variable/manrope',
    ],
  },
  server: { fs: { allow: ['..'] } },
  build: { chunkSizeWarningLimit: 1200 },
});
