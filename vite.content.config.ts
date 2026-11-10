import { CONTENT_SCRIPT_FILE } from './src/shared/constants';
import { defineConfig } from 'vite';

export default defineConfig({
    build: {
        outDir: 'dist',
        emptyOutDir: false,
        lib: {
            entry: {
                pickImage: 'src/content/pickImage.ts',
            },
            name: 'comicTranslatorPicker',
            formats: ['iife'],
            fileName: () => CONTENT_SCRIPT_FILE,
        },
    },
});
