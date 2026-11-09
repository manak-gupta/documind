import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // The browser only ever talks to one origin. /api/* is forwarded to the Fastify API with the
    // prefix stripped. Same origin means: no CORS setup, and the session cookie just works.
    // In production, Caddy does the same job (see the Caddyfile).
    proxy: {
      '/api': {
        target: process.env.API_URL ?? 'http://localhost:4000', // the e2e tests use their own API port
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  build: {
    sourcemap: true,
    rollupOptions: {
      output: {
        // pdf.js is large and only needed when a source is opened: keep it in its own file
        // so the first page load stays small.
        manualChunks: (id) => (id.includes('pdfjs-dist') ? 'pdfjs' : undefined),
      },
    },
  },
});
