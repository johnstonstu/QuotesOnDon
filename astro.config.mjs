// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// Custom domain is quotesondon.com; the GitHub Pages fallback URL is used for previews.
export default defineConfig({
  site: process.env.SITE_URL || 'https://quotesondon.com',
  trailingSlash: 'ignore',
  integrations: [sitemap()],
  build: {
    inlineStylesheets: 'auto',
  },
});