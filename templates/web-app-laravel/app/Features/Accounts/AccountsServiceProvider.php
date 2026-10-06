<?php

declare(strict_types=1);

namespace App\Features\Accounts;

use App\Features\Accounts\Actions\CreateNewUser;
use App\Features\Accounts\Actions\ResetUserPassword;
use App\Features\Accounts\Http\Responses\GenericResetLinkResponse;
use Illuminate\Cache\RateLimiting\Limit;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\ServiceProvider;
use Illuminate\Support\Str;
use Laravel\Fortify\Contracts\FailedPasswordResetLinkRequestResponse;
use Laravel\Fortify\Fortify;

/**
 * Wires Laravel Fortify (headless authentication: the routes, the throttling,
 * the session handling) to our actions and our Blade views. Fortify is the
 * maintained successor to Breeze's scaffolding: its code stays in vendor/ and
 * gets security fixes with `composer update`, instead of being copied into the app.
 */
final class AccountsServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        // Overrides Fortify's binding: no "no such user" answer (account enumeration).
        $this->app->bind(FailedPasswordResetLinkRequestResponse::class, GenericResetLinkResponse::class);
    }

    public function boot(): void
    {
        Fortify::createUsersUsing(CreateNewUser::class);
        Fortify::resetUserPasswordsUsing(ResetUserPassword::class);

        Fortify::loginView(fn () => view('auth.login'));
        Fortify::registerView(fn () => view('auth.register'));
        Fortify::requestPasswordResetLinkView(fn () => view('auth.forgot-password'));
        Fortify::resetPasswordView(fn (Request $request) => view('auth.reset-password', ['request' => $request]));

        // 5 attempts a minute per email+IP pair (Fortify applies this to POST /login).
        RateLimiter::for('login', function (Request $request) {
            $email = Str::transliterate(Str::lower($request->string(Fortify::username())->toString()));

            return [
                Limit::perMinute(5)->by($email.'|'.$request->ip()),
                Limit::perMinute(30)->by($request->ip()),
            ];
        });
    }
}
