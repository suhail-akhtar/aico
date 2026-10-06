<?php

declare(strict_types=1);

use App\Support\Http\Controllers\ReadinessController;
use App\Support\Http\Middleware\RequestContext;
use App\Support\Http\Middleware\RequireJsonBody;
use App\Support\Http\Middleware\SecurityHeaders;
use App\Support\Http\ProblemDetails;
use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Route;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        api: __DIR__.'/../routes/api.php',
        commands: __DIR__.'/../routes/console.php',
        // Liveness: Laravel's built-in route, no database. /readyz (below) checks it.
        health: '/healthz',
        then: function (): void {
            // Outside the web group on purpose: a probe must not start a session.
            Route::get('/readyz', ReadinessController::class)->name('readyz');
        },
    )
    ->withCommands([__DIR__.'/../app/Support/Console'])
    ->withMiddleware(function (Middleware $middleware): void {
        $middleware->redirectUsersTo('/items');
        $middleware->prepend(RequestContext::class);
        $middleware->append(SecurityHeaders::class);
        $middleware->web(append: ['throttle:web']);
        $middleware->api(prepend: [RequireJsonBody::class]);
    })
    ->withExceptions(function (Exceptions $exceptions): void {
        $exceptions->shouldRenderJsonWhen(
            fn (Request $request) => $request->is('api/*') || $request->expectsJson(),
        );
        // RFC 9457 problem details for every API error; null leaves HTML pages alone.
        $exceptions->render(fn (Throwable $e, Request $request) => ProblemDetails::render($e, $request));
    })->create();
