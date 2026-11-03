import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    lib: {
      entry: 'src/content/pickImage.ts',
      name: 'comicTranslatorPicker',
      formats: ['iife'],
      fileName: () => 'content.js',
    },
  },
});
