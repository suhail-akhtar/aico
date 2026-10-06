<x-layouts.guest title="Choose a new password">
    <h1 class="mb-4 text-xl font-semibold">Choose a new password</h1>
    <form method="POST" action="{{ route('password.update') }}">
        @csrf
        <input type="hidden" name="token" value="{{ $request->route('token') }}">
        <x-field name="email" label="Email" type="email" :value="$request->email" autocomplete="username" required />
        <x-field name="password" label="New password (12 characters or more)" type="password" autocomplete="new-password" required minlength="12" />
        <x-field name="password_confirmation" label="Confirm password" type="password" autocomplete="new-password" required />
        <button type="submit" class="btn w-full">Set password</button>
    </form>
</x-layouts.guest>
