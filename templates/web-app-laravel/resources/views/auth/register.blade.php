<x-layouts.guest title="Create account">
    <h1 class="mb-4 text-xl font-semibold">Create your account</h1>
    <form method="POST" action="{{ route('register') }}">
        @csrf
        <x-field name="name" label="Name" autocomplete="name" required autofocus />
        <x-field name="email" label="Email" type="email" autocomplete="username" required />
        <x-field name="password" label="Password (12 characters or more)" type="password" autocomplete="new-password" required minlength="12" />
        <x-field name="password_confirmation" label="Confirm password" type="password" autocomplete="new-password" required />
        <button type="submit" class="btn w-full">Create account</button>
    </form>
    <p class="mt-4 text-sm">Already registered? <a href="{{ route('login') }}" class="underline">Sign in</a></p>
</x-layouts.guest>
