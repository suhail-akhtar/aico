<?php

declare(strict_types=1);

namespace App\Support\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * API writes must send JSON. Without this, Laravel quietly accepts form-encoded
 * and multipart bodies on the same routes, which widens what a browser form on
 * another origin can submit (a classic CSRF-adjacent surface) for no benefit.
 * Anything else with a body gets 415 (rendered as problem details).
 */
final class RequireJsonBody
{
    /**
     * @param  Closure(Request): Response  $next
     */
    public function handle(Request $request, Closure $next): Response
    {
        if (in_array($request->method(), ['POST', 'PUT', 'PATCH'], true)
            && $request->getContent() !== ''
            && ! $request->isJson()) {
            abort(415);
        }

        return $next($request);
    }
}
