<x-layouts.guest title="Sign in">
    <h1 class="mb-4 text-xl font-semibold">Sign in</h1>
    <form method="POST" action="{{ route('login') }}">
        @csrf
        <x-field name="email" label="Email" type="email" autocomplete="username" required autofocus />
        <x-field name="password" label="Password" type="password" autocomplete="current-password" required />
        <label class="mb-4 flex items-center gap-2 text-sm">
            <input type="checkbox" name="remember" value="1"> Remember me
        </label>
        <button type="submit" class="btn w-full">Sign in</button>
    </form>
    <p class="mt-4 text-sm">
        <a href="{{ route('password.request') }}" class="underline">Forgot your password?</a>
        &middot; <a href="{{ route('register') }}" class="underline">Create an account</a>
    </p>
</x-layouts.guest>
