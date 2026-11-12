import { OFFSCREEN_HTML, POPUP_HTML } from './src/shared/constants';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
    plugins: [react()],
    define: { __BUILD_ID__: JSON.stringify(process.env.BUILD_ID ?? String(Date.now())) },
    build: {
        outDir: 'dist',
        emptyOutDir: true,
        rollupOptions: {
            input: { popup: POPUP_HTML, offscreen: OFFSCREEN_HTML },
        },
    },
});
