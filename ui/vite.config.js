// The Svelte interface, built into web/ui/ (app.js and app.css, fixed names) and loaded by web/index.html. See docs/ui.md.
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte()],
  publicDir: false,
  build: {
    outDir: '../web/ui',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    rollupOptions: {
      input: 'src/main.js',
      output: { entryFileNames: 'app.js', chunkFileNames: '[name].js', assetFileNames: 'app[extname]' },
    },
  },
});
