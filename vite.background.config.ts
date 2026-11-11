import { defineConfig } from 'vite';

export default defineConfig({
    define: { __BUILD_ID__: JSON.stringify(process.env.BUILD_ID ?? String(Date.now())) },
    build: {
        outDir: 'dist',
        emptyOutDir: false,
        lib: {
            entry: 'src/background/index.ts',
            formats: ['es'],
            fileName: () => 'background.js',
        },
    },
});
