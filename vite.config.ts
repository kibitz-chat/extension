import { defineConfig } from 'vite'

// Builds the side-panel app (src/sidepanel.ts) into one classic IIFE at the repo
// root, next to the manifest. The call engine is NOT bundled — it's the vendored
// widget.js, loaded via <script> in sidepanel.html and used as window.Kibitz.
export default defineConfig({
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    outDir: '.',
    emptyOutDir: false,
    lib: { entry: 'src/sidepanel.ts', name: 'KibitzSidePanel', formats: ['iife'], fileName: () => 'sidepanel.js' },
  },
})
