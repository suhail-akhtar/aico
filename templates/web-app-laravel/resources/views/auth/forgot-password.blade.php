<x-layouts.guest title="Reset password">
    <h1 class="mb-4 text-xl font-semibold">Reset your password</h1>
    @if (session('status'))
        <p class="mb-4 text-sm" role="status">{{ session('status') }}</p>
    @endif
    <form method="POST" action="{{ route('password.email') }}">
        @csrf
        <x-field name="email" label="Email" type="email" autocomplete="username" required autofocus />
        <button type="submit" class="btn w-full">Email me a reset link</button>
    </form>
    <p class="mt-4 text-sm"><a href="{{ route('login') }}" class="underline">Back to sign in</a></p>
</x-layouts.guest>
