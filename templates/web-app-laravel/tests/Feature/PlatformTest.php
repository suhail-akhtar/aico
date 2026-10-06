<?php

declare(strict_types=1);

use App\Features\Accounts\Models\User;
use App\Providers\AppServiceProvider;
use Illuminate\Http\Middleware\TrustProxies;
use Illuminate\Support\Facades\Context;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Gate;

it('answers /healthz without touching the database', function (): void {
    DB::shouldReceive('select')->never();

    $this->get('/healthz')->assertOk();
});

it('answers /readyz ok when the database is reachable', function (): void {
    $this->getJson('/readyz')->assertOk()->assertJson(['status' => 'ok']);
});

it('answers /readyz 503 without detail when the database is down', function (): void {
    DB::shouldReceive('select')->andThrow(new RuntimeException('connection refused to 10.0.0.5'));

    $response = $this->getJson('/readyz')->assertStatus(503)->assertJson(['status' => 'unavailable']);

    expect($response->getContent())->not->toContain('10.0.0.5');
});

it('does not start a session for probes', function (): void {
    $this->get('/healthz')->assertCookieMissing('laravel-session');
    $this->getJson('/readyz')->assertCookieMissing('laravel-session');
});

it('sets browser hardening headers and a nonce-based CSP on pages', function (): void {
    $response = $this->get('/login')->assertOk();

    $response->assertHeader('X-Content-Type-Options', 'nosniff')
        ->assertHeader('X-Frame-Options', 'DENY')
        ->assertHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
        ->assertHeader('Cross-Origin-Opener-Policy', 'same-origin')
        ->assertHeader('Permissions-Policy');

    $csp = (string) $response->headers->get('Content-Security-Policy');
    expect($csp)->toContain("default-src 'none'")
        ->toContain("frame-ancestors 'none'")
        ->toContain("base-uri 'none'")
        ->toMatch("/script-src 'self' 'nonce-[A-Za-z0-9]+'/")
        ->not->toContain('unsafe-inline')
        ->not->toContain('unsafe-eval');
});

it('uses a fresh CSP nonce on every response', function (): void {
    $a = (string) $this->get('/login')->headers->get('Content-Security-Policy');
    $b = (string) $this->get('/login')->headers->get('Content-Security-Policy');

    expect($a)->not->toBe($b);
});

it('marks API responses no-store and gives them no CSP', function (): void {
    [, $headers] = userWithToken();

    $response = $this->getJson('/api/v1/items', $headers)->assertOk();

    expect($response->headers->get('Cache-Control'))->toContain('no-store')
        ->and($response->headers->has('Content-Security-Policy'))->toBeFalse();
});

it('sends HSTS only over HTTPS in production', function (): void {
    $this->get('/login')->assertHeaderMissing('Strict-Transport-Security');

    $this->app['env'] = 'production';
    config(['app.env' => 'production']);
    $this->get('https://localhost/login')->assertHeader('Strict-Transport-Security');
});

it('allows a listed origin to call the API from a browser and nobody else', function (): void {
    $allowed = $this->call('OPTIONS', '/api/v1/items', [], [], [], [
        'HTTP_ORIGIN' => 'https://app.example.test',
        'HTTP_ACCESS_CONTROL_REQUEST_METHOD' => 'GET',
        'HTTP_ACCESS_CONTROL_REQUEST_HEADERS' => 'authorization',
    ]);
    expect($allowed->headers->get('Access-Control-Allow-Origin'))->toBe('https://app.example.test')
        ->and($allowed->headers->has('Access-Control-Allow-Credentials'))->toBeFalse();

    $denied = $this->call('OPTIONS', '/api/v1/items', [], [], [], [
        'HTTP_ORIGIN' => 'https://evil.example.test',
        'HTTP_ACCESS_CONTROL_REQUEST_METHOD' => 'GET',
    ]);
    // With one configured origin the middleware answers with that origin, never with the caller's.
    expect($denied->headers->get('Access-Control-Allow-Origin'))->not->toBe('https://evil.example.test');
});

it('adds the trace id from a valid traceparent to the log context', function (): void {
    $this->get('/healthz', ['traceparent' => '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01']);

    expect(Context::get('trace_id'))->toBe('4bf92f3577b34da6a3ce929d0e0e4736');
});

it('ignores a malformed or all-zero traceparent', function (string $value): void {
    Context::flush();
    $this->get('/healthz', ['traceparent' => $value]);

    expect(Context::has('trace_id'))->toBeFalse();
})->with(['garbage', '00-00000000000000000000000000000000-00f067aa0ba902b7-01', '99-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7']);

it('puts a request id on every response, including pages', function (): void {
    $this->get('/login')->assertHeader('X-Request-Id');
});

it('serves the OpenAPI document where the docs gate allows it, and 403 elsewhere', function (): void {
    $this->get('/docs/api.json')->assertOk()->assertJsonPath('openapi', fn (string $v): bool => str_starts_with($v, '3.'));

    config(['app.api_docs' => false]);
    $this->app->forgetInstance('gate');
    Gate::define('viewApiDocs', fn (?User $user = null): bool => (bool) config('app.api_docs'));
    $this->get('/docs/api.json')->assertForbidden();
});

it('does not serve the third-party-script docs UI', function (): void {
    $this->get('/docs/api')->assertNotFound();
});

it('ignores X-Forwarded-For unless the sender is a configured proxy', function (): void {
    $server = ['REMOTE_ADDR' => '10.1.2.3'];
    $forwarded = ['X-Forwarded-For' => '203.0.113.9'];

    $this->withServerVariables($server)->get('/healthz', $forwarded);
    expect(request()->ip())->toBe('10.1.2.3');

    config(['app.trusted_proxies' => '10.0.0.0/8']);
    $provider = new AppServiceProvider($this->app);
    (new ReflectionMethod($provider, 'trustConfiguredProxies'))->invoke($provider);
    try {
        $this->withServerVariables($server)->get('/healthz', $forwarded);
        expect(request()->ip())->toBe('203.0.113.9');
    } finally {
        TrustProxies::flushState();
    }
});

it('allows only the running Vite dev server origin in the CSP, and nothing else a file could say', function (): void {
    $hot = public_path('hot');
    try {
        file_put_contents($hot, 'http://localhost:5173');
        $csp = (string) $this->get('/login')->headers->get('Content-Security-Policy');
        expect($csp)->toContain('http://localhost:5173')->toContain('ws://localhost:5173');

        file_put_contents($hot, 'http://evil.example; script-src *');
        $csp = (string) $this->get('/login')->headers->get('Content-Security-Policy');
        expect($csp)->not->toContain('evil.example');
    } finally {
        @unlink($hot);
    }
});
