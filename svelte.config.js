import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter(),
    // Inline small stylesheets so the landing page has no render-blocking CSS requests.
    inlineStyleThreshold: 20 * 1024,
    files: {
      assets: 'public'
    }
  }
};

export default config;
