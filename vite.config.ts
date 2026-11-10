import { OFFSCREEN_HTML, POPUP_HTML } from './src/shared/constants';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: { popup: POPUP_HTML, offscreen: OFFSCREEN_HTML },
    },
  },
});
