import { fileURLToPath } from 'node:url';
// Explicit path: the build runs from desktop/, not from here.
export default {
  plugins: {
    tailwindcss: { config: fileURLToPath(new URL('./tailwind.config.js', import.meta.url)) },
    autoprefixer: {},
  },
};
