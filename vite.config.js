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
  plugins: [sveltekit(), stripPdfWorkerSourceMapReference],
  optimizeDeps: {
    exclude: ['pdfjs-dist']
  }
});
