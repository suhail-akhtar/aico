import { defineConfig } from 'astro/config';

// Static output: the site is files, served by nginx in the image or any static host.
export default defineConfig({
  output: 'static',
  trailingSlash: 'ignore',
  build: { format: 'directory' },
});
