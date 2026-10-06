import { defineConfig } from 'vite';
import laravel from 'laravel-vite-plugin';
import tailwindcss from '@tailwindcss/vite';

// Fonts: the system font stack (see resources/css/app.css). No font CDN: nothing
// leaves the user's browser for a third party, and the CSP stays 'self'.
export default defineConfig({
    plugins: [
        laravel({
            input: ['resources/css/app.css', 'resources/js/app.js'],
            refresh: true,
        }),
        tailwindcss(),
    ],
    server: {
        // Inside Docker the server binds 0.0.0.0, but the browser must be told the address it can
        // actually reach (this goes into public/hot, which the CSP and @vite read).
        origin: `http://localhost:${process.env.VITE_PORT ?? 5173}`,
        // Setting `origin` makes the plugin allow ONLY that origin; the page comes from the app's
        // port, so allow the app on any loopback address instead (never other hosts).
        cors: { origin: [/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/] },
        watch: {
            ignored: ['**/storage/framework/views/**', '**/vendor/**'],
        },
    },
});
