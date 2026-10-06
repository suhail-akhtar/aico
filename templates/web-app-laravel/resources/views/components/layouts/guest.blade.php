@props(['title' => config('app.name')])
<!DOCTYPE html>
<html lang="{{ str_replace('_', '-', app()->getLocale()) }}">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>{{ $title }} - {{ config('app.name') }}</title>
    <x-assets />
</head>
<body class="min-h-screen antialiased">
    <main class="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-12">
        <a href="{{ route('home') }}" class="mb-8 text-center text-xl font-semibold">{{ config('app.name') }}</a>
        <div class="card">
            {{ $slot }}
        </div>
    </main>
</body>
</html>
