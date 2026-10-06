<?php

declare(strict_types=1);

use App\Features\Accounts\Models\User;
use Database\Factories\UserFactory;
use Illuminate\Auth\Notifications\ResetPassword;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Notification;

it('shows the sign-up and sign-in pages to guests', function (): void {
    $this->get('/register')->assertOk()->assertSee('Create your account');
    $this->get('/login')->assertOk()->assertSee('Sign in');
    $this->get('/')->assertOk()->assertSee('Create an account');
});

it('signs a user up, hashes the password with Argon2id, and lands on /items', function (): void {
    $this->post('/register', [
        'name' => 'Ada Lovelace',
        'email' => 'Ada@Example.test',
        'password' => 'correct horse battery staple',
        'password_confirmation' => 'correct horse battery staple',
    ])->assertRedirect('/items');

    $user = User::query()->where('email', 'ada@example.test')->firstOrFail();
    expect($user->password)->toStartWith('$argon2id$')
        ->and(Hash::check('correct horse battery staple', $user->password))->toBeTrue();
    $this->assertAuthenticatedAs($user);
});

it('rejects weak, mismatched and breached-length passwords', function (string $password, string $confirmation): void {
    $this->from('/register')->post('/register', [
        'name' => 'Ada', 'email' => 'ada@example.test', 'password' => $password, 'password_confirmation' => $confirmation,
    ])->assertRedirect('/register')->assertSessionHasErrors('password');

    $this->assertGuest();
    expect(User::query()->count())->toBe(0);
})->with([
    'too short' => ['short', 'short'],
    'mismatch' => ['correct horse battery staple', 'something else entirely'],
    'too long' => [str_repeat('a', 129), str_repeat('a', 129)],
]);

it('rejects a duplicate email regardless of case', function (): void {
    User::factory()->create(['email' => 'ada@example.test']);

    $this->from('/register')->post('/register', [
        'name' => 'Ada', 'email' => 'ADA@example.test', 'password' => 'correct horse battery staple', 'password_confirmation' => 'correct horse battery staple',
    ])->assertSessionHasErrors('email');
});

it('signs in and out', function (): void {
    $user = User::factory()->create(['email' => 'ada@example.test']);

    $this->post('/login', ['email' => 'ada@example.test', 'password' => UserFactory::PASSWORD])->assertRedirect('/items');
    $this->assertAuthenticatedAs($user);

    $this->post('/logout')->assertRedirect('/');
    $this->assertGuest();
});

it('does not reveal whether the email or the password was wrong', function (): void {
    User::factory()->create(['email' => 'ada@example.test']);

    $a = $this->from('/login')->post('/login', ['email' => 'ada@example.test', 'password' => 'wrong']);
    $b = $this->from('/login')->post('/login', ['email' => 'nobody@example.test', 'password' => 'wrong']);

    $a->assertSessionHasErrors(['email' => trans('auth.failed')]);
    $b->assertSessionHasErrors(['email' => trans('auth.failed')]);
});

it('throttles sign-in attempts', function (): void {
    User::factory()->create(['email' => 'ada@example.test']);

    foreach (range(1, 5) as $_) {
        $this->post('/login', ['email' => 'ada@example.test', 'password' => 'wrong'])->assertSessionHasErrors('email');
    }

    $this->post('/login', ['email' => 'ada@example.test', 'password' => UserFactory::PASSWORD])->assertStatus(429);
    $this->assertGuest();
});

it('sends guests who open /items to the sign-in page', function (): void {
    $this->get('/items')->assertRedirect('/login');
});

it('sends signed-in users away from the sign-in page', function (): void {
    $this->actingAs(User::factory()->create())->get('/login')->assertRedirect('/items');
});

it('regenerates the session id on sign-in (no session fixation)', function (): void {
    User::factory()->create(['email' => 'ada@example.test']);

    $this->get('/login');
    $before = session()->getId();
    $this->post('/login', ['email' => 'ada@example.test', 'password' => UserFactory::PASSWORD]);

    expect(session()->getId())->not->toBe($before);
});

it('resets a forgotten password through an emailed link', function (): void {
    Notification::fake();
    $user = User::factory()->create(['email' => 'ada@example.test']);

    $this->post('/forgot-password', ['email' => 'ada@example.test'])->assertSessionHas('status');
    Notification::assertSentTo($user, ResetPassword::class, function (ResetPassword $n) use ($user): bool {
        $this->get('/reset-password/'.$n->token.'?email='.urlencode($user->email))->assertOk()->assertSee('Choose a new password');

        $this->post('/reset-password', [
            'token' => $n->token, 'email' => $user->email,
            'password' => 'a brand new long passphrase', 'password_confirmation' => 'a brand new long passphrase',
        ])->assertRedirect('/login');

        return true;
    });

    expect(Hash::check('a brand new long passphrase', (string) $user->fresh()?->password))->toBeTrue();
});

it('does not say whether an email is registered when asking for a reset link', function (): void {
    Notification::fake();

    $known = User::factory()->create(['email' => 'ada@example.test']);
    $this->post('/forgot-password', ['email' => 'ada@example.test'])->assertSessionHas('status');
    Notification::assertSentTo($known, ResetPassword::class);

    // Same answer for an address that has no account, and no mail is sent.
    $this->post('/forgot-password', ['email' => 'nobody@example.test'])->assertSessionHas('status')->assertSessionHasNoErrors();
    Notification::assertCount(1);
});
