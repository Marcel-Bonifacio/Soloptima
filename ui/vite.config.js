// The Svelte interface, built into web/ui/ (app.js and app.css, fixed names) and loaded by web/index.html. See docs/ui.md.
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte()],
  publicDir: false,
  base: './',   // the chunks load beside app.js (web/ui/), also their preloads, not from the site root
  build: {
    outDir: '../web/ui',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    // unminified: a stack line of an error report maps back to its source file (reports/doc.js, sourceOf); 1.2 MB, read locally
    minify: false,
    rollupOptions: {
      input: 'src/main.js',
      output: { entryFileNames: 'app.js', chunkFileNames: '[name].js', assetFileNames: 'app[extname]' },
    },
  },
});
