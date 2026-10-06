<?php

declare(strict_types=1);

namespace App\Support\Http\Middleware;

use Closure;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Vite;
use Symfony\Component\HttpFoundation\Response;

/**
 * Browser hardening headers on every response (OWASP HTTP Headers cheat sheet).
 *
 * The Content-Security-Policy is a nonce policy: only scripts and styles the
 * server marked with this request's nonce run, so an injected `<script>` is
 * inert even if escaping were ever missed. Blade's `@vite` and Livewire read
 * the nonce from `Vite::cspNonce()`. `connect-src 'self'` covers Livewire's
 * own endpoint. JSON responses get no CSP (nothing renders them) but are
 * `no-store`. HSTS is sent only over HTTPS in production, never on plain
 * HTTP where it would be meaningless.
 */
final class SecurityHeaders
{
    /**
     * @param  Closure(Request): Response  $next
     */
    public function handle(Request $request, Closure $next): Response
    {
        $nonce = Vite::useCspNonce();

        $response = $next($request);
        $headers = $response->headers;

        $headers->set('X-Content-Type-Options', 'nosniff');
        $headers->set('X-Frame-Options', 'DENY');
        $headers->set('Referrer-Policy', 'strict-origin-when-cross-origin');
        $headers->set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
        $headers->set('Cross-Origin-Opener-Policy', 'same-origin');

        if ($response instanceof JsonResponse || $request->is('api/*')) {
            $headers->set('Cache-Control', 'no-store');
        } else {
            $headers->set('Content-Security-Policy', $this->csp($nonce));
        }

        if ($request->isSecure() && app()->isProduction()) {
            $headers->set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
        }

        return $response;
    }

    private function csp(string $nonce): string
    {
        $script = "'self' 'nonce-{$nonce}'";
        $style = "'self' 'nonce-{$nonce}'";
        $connect = "'self'";

        // `make dev` runs the Vite dev server on another origin; allow exactly that one, only while it runs.
        if (Vite::isRunningHot()) {
            $hot = trim((string) @file_get_contents(public_path('hot')));
            if (preg_match('#^https?://[A-Za-z0-9.\[\]:-]+$#', $hot) === 1) {
                $script .= ' '.$hot;
                $style .= ' '.$hot;
                $connect .= ' '.$hot.' '.preg_replace('#^http#', 'ws', $hot);
            }
        }

        return implode('; ', [
            "default-src 'none'",
            "script-src {$script}",
            "style-src {$style}",
            "img-src 'self' data:",
            "font-src 'self'",
            "connect-src {$connect}",
            "form-action 'self'",
            "base-uri 'none'",
            "frame-ancestors 'none'",
            "object-src 'none'",
        ]);
    }
}
