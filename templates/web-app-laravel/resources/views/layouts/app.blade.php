<!DOCTYPE html>
<html lang="{{ str_replace('_', '-', app()->getLocale()) }}">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>{{ $title ?? 'Home' }} - {{ config('app.name') }}</title>
    <x-assets />
</head>
<body class="min-h-screen antialiased">
    <header class="app-header">
        <nav class="mx-auto flex max-w-3xl items-center justify-between px-4 py-3" aria-label="Main">
            <div class="flex items-center gap-6">
                <a href="{{ route('home') }}" class="font-semibold">{{ config('app.name') }}</a>
                <a href="{{ route('items') }}" class="text-sm" aria-current="page">Items</a>
            </div>
            <div class="flex items-center gap-3 text-sm">
                <span class="muted">{{ auth()->user()?->name }}</span>
                <form method="POST" action="{{ route('logout') }}">
                    @csrf
                    <button type="submit" class="btn-quiet">Sign out</button>
                </form>
            </div>
        </nav>
    </header>
    <main class="mx-auto max-w-3xl px-4 py-8">
        {{ $slot }}
    </main>
</body>
</html>
