{{-- The page's CSS/JS. With a Vite build (or the dev server) the real bundle; without one
     (no Node on this machine) a small hand-written stylesheet, so the app is still usable. --}}
@if (is_file(public_path('build/manifest.json')) || is_file(public_path('hot')))
    @vite(['resources/css/app.css', 'resources/js/app.js'])
@else
    <link rel="stylesheet" href="{{ asset('css/fallback.css') }}">
@endif
