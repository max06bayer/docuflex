import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

const pdfWorkerSourceMapComment = /\n?\/\/# sourceMappingURL=pdf\.worker\.mjs\.map\s*$/;

/** @type {import('vite').Plugin} */
const stripPdfWorkerSourceMapReference = {
  name: 'strip-pdf-worker-source-map-reference',
  generateBundle(_options, bundle) {
    for (const output of Object.values(bundle)) {
      if (output.type !== 'asset' || !output.fileName.includes('pdf.worker') || !output.fileName.endsWith('.mjs')) {
        continue;
      }
      const source = typeof output.source === 'string' ? output.source : new TextDecoder().decode(output.source);
      output.source = source.replace(pdfWorkerSourceMapComment, '');
    }
  }
};

export default defineConfig({
  plugins: [
    sveltekit({
      preprocess: vitePreprocess(),
      adapter: adapter(),
      // Desktop services use plain HTTP on a fixed loopback port.
      paths: { origin: process.env.DOCUFLEX_DESKTOP_ORIGIN || undefined },
      // Inline small stylesheets so the landing page has no render-blocking CSS requests.
      inlineStyleThreshold: 20 * 1024,
      files: { assets: 'public' }
    }),
    stripPdfWorkerSourceMapReference
  ],
  build: {
    // Landing images repeat in the marquees; as base64 they would bloat the
    // prerendered HTML instead of being cached as files.
    assetsInlineLimit: (file) => file.includes('/assets/landing/') ? false : undefined
  },
  ssr: { noExternal: ['maxmind', 'mmdb-lib', 'tiny-lru'] },
  optimizeDeps: {
    exclude: ['pdfjs-dist']
  }
});
