import { CONTENT_SCRIPT_FILE } from './src/shared/constants';
import { defineConfig } from 'vite';

export default defineConfig({
    define: { __BUILD_ID__: JSON.stringify(process.env.BUILD_ID ?? String(Date.now())) },
    build: {
        outDir: 'dist',
        emptyOutDir: false,
        lib: {
            entry: {
                pickImage: 'src/content-script/pickImage.ts',
            },
            name: 'comicTranslatorPicker',
            formats: ['iife'],
            fileName: () => CONTENT_SCRIPT_FILE,
        },
    },
});
