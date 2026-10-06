<x-layouts.guest title="Welcome">
    <h1 class="text-2xl font-semibold">{{ config('app.name') }}</h1>
    <p class="muted mt-2">Placeholder: describe what your product does in one sentence.</p>
    <div class="mt-6 flex gap-3">
        @auth
            <a href="{{ route('items') }}" class="btn">Open your items</a>
        @else
            <a href="{{ route('register') }}" class="btn">Create an account</a>
            <a href="{{ route('login') }}" class="btn-quiet">Sign in</a>
        @endauth
    </div>
</x-layouts.guest>
