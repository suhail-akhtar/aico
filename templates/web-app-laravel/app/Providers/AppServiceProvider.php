<?php

declare(strict_types=1);

namespace App\Providers;

use App\Features\Accounts\Models\User;
use App\Support\Config\EnvironmentGuard;
use Dedoc\Scramble\Scramble;
use Illuminate\Cache\RateLimiting\Limit;
use Illuminate\Contracts\Config\Repository;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Foundation\Application;
use Illuminate\Http\Middleware\TrustProxies;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\ServiceProvider;
use RuntimeException;

/**
 * The composition root for everything shared: strictness, rate limits, the
 * startup config check, the API docs gate. Feature wiring lives in the
 * feature's own provider (see Features/Accounts/AccountsServiceProvider).
 */
final class AppServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->app->singleton(EnvironmentGuard::class, fn (Application $app) => new EnvironmentGuard($app->make(Repository::class)));

        // Only the JSON document is served (see routes/web.php): the bundled
        // browser UI loads its JavaScript from a public CDN, which a nonce-only
        // CSP and a supply-chain-minded team should not allow.
        Scramble::ignoreDefaultRoutes();
    }

    public function boot(): void
    {
        // Catch lazy loading (N+1), silently discarded attributes and
        // mass-assignment surprises while developing; never in production,
        // where a logged violation is better than a 500.
        Model::shouldBeStrict(! $this->app->isProduction());

        $this->trustConfiguredProxies();
        $this->failFastOnBadConfig();
        $this->defineRateLimiters();

        // Who may read the OpenAPI document outside local development.
        Gate::define('viewApiDocs', fn (?User $user = null): bool => (bool) config('app.api_docs'));
    }

    /**
     * Behind a reverse proxy set TRUSTED_PROXIES (comma-separated IPs/CIDRs, or `*`
     * only when the app is reachable exclusively through the proxy). Left empty,
     * X-Forwarded-* headers are ignored, so a client cannot spoof its IP or scheme.
     */
    private function trustConfiguredProxies(): void
    {
        $proxies = config('app.trusted_proxies');

        if (is_string($proxies) && $proxies !== '') {
            TrustProxies::at($proxies === '*' ? '*' : array_map('trim', explode(',', $proxies)));
        }
    }

    /**
     * Web requests only: console commands must still run to FIX the config
     * (key:generate, config:clear), and the container entrypoint checks with
     * `app:check-config` before any server starts.
     */
    private function failFastOnBadConfig(): void
    {
        if ($this->app->runningInConsole()) {
            return;
        }

        $errors = $this->app->make(EnvironmentGuard::class)->errors();
        if ($errors !== []) {
            throw new RuntimeException("Invalid configuration:\n- ".implode("\n- ", $errors));
        }
    }

    private function defineRateLimiters(): void
    {
        // Browser traffic: generous, per user (or per IP before sign-in).
        RateLimiter::for('web', fn (Request $request) => Limit::perMinute(240)->by($request->user()?->getAuthIdentifier() ?? $request->ip()));

        // JSON API: per token holder.
        RateLimiter::for('api', fn (Request $request) => Limit::perMinute(60)->by($request->user()?->getAuthIdentifier() ?? $request->ip()));

        // Credential guessing: per email AND per IP, so one address cannot be
        // hammered from many places nor many addresses from one place.
        RateLimiter::for('tokens', fn (Request $request) => [
            Limit::perMinute(5)->by('tokens:'.mb_strtolower($request->string('email')->toString()).'|'.$request->ip()),
            Limit::perMinute(20)->by('tokens-ip:'.$request->ip()),
        ]);
    }
}
