import { defineConfig } from 'vite';

// GitHub Pages serves the repo at /instagram-dm-viewer/, so the production
// build needs that prefix on asset URLs. Local dev (npm run dev) sets
// VITE_BASE='' so paths stay rooted at /.
const base = process.env.VITE_BASE ?? '/instagram-dm-viewer/';

export default defineConfig({
  base,
  server: {
    port: 5173,
  },
  build: {
    target: 'esnext',
  },
});
