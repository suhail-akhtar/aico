<?php

declare(strict_types=1);

namespace App\Support\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Context;
use Illuminate\Support\Str;
use Symfony\Component\HttpFoundation\Response;

/**
 * Gives every request an id and puts it on every log line.
 *
 * - `X-Request-Id`: honoured when the caller (or the proxy) sends a sane one,
 *   otherwise a UUID is made. It is returned on the response and appears in
 *   problem-details bodies, so "it failed at 14:02" becomes one grep.
 * - `traceparent` (W3C Trace Context): when a valid one arrives, its trace id
 *   is logged too, so these logs join a distributed trace. No SDK is needed
 *   for that; add OpenTelemetry later and the ids already line up.
 *
 * Laravel's Context facade copies what we add into every log record's `extra`.
 */
final class RequestContext
{
    /**
     * @param  Closure(Request): Response  $next
     */
    public function handle(Request $request, Closure $next): Response
    {
        $incoming = $request->headers->get('X-Request-Id');
        $id = is_string($incoming) && preg_match('/^[A-Za-z0-9._-]{8,64}$/', $incoming) === 1
            ? $incoming
            : (string) Str::uuid();

        $request->attributes->set('request_id', $id);
        Context::add('request_id', $id);

        $trace = self::traceId($request->headers->get('traceparent'));
        if ($trace !== null) {
            Context::add('trace_id', $trace);
        }

        $response = $next($request);
        $response->headers->set('X-Request-Id', $id);

        return $response;
    }

    private static function traceId(?string $header): ?string
    {
        if ($header === null || preg_match('/^00-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/', $header, $m) !== 1) {
            return null;
        }

        return $m[1] === str_repeat('0', 32) ? null : $m[1];
    }
}
