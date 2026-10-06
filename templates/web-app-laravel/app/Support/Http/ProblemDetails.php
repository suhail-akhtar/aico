<?php

declare(strict_types=1);

namespace App\Support\Http;

use Illuminate\Auth\Access\AuthorizationException;
use Illuminate\Auth\AuthenticationException;
use Illuminate\Database\Eloquent\ModelNotFoundException;
use Illuminate\Http\Exceptions\PostTooLargeException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\ValidationException;
use Symfony\Component\HttpKernel\Exception\HttpExceptionInterface;
use Symfony\Component\HttpKernel\Exception\MethodNotAllowedHttpException;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;
use Throwable;

/**
 * Every error an API client can see, in one shape: RFC 9457 problem details
 * (`application/problem+json`), the same members for a 404 and for a 500.
 *
 * Why this exists: Laravel's default JSON errors differ by failure (a
 * `{"message": ...}` here, a validation envelope there, a stack trace in
 * debug). A client should write one error handler. `type` is a stable URN per
 * error class, `code` the same slug for easy switch statements, `request_id`
 * ties the response to the log line. A 500 never carries the exception
 * message: it is logged, not shown.
 *
 * Wired in `bootstrap/app.php`. Browser (HTML) requests return null here and
 * keep Laravel's normal pages and redirects.
 */
final class ProblemDetails
{
    public const CONTENT_TYPE = 'application/problem+json';

    public static function render(Throwable $e, Request $request): ?JsonResponse
    {
        if (! $request->is('api/*') && ! $request->expectsJson()) {
            return null;
        }

        [$status, $code, $title, $detail, $extra, $headers] = self::describe($e);

        $requestId = $request->attributes->get('request_id');
        $body = array_filter([
            'type' => 'urn:problem:'.$code,
            'title' => $title,
            'status' => $status,
            'detail' => $detail,
            'instance' => is_string($requestId) ? 'urn:request:'.$requestId : null,
            'code' => $code,
            'request_id' => $requestId,
        ], static fn (mixed $v): bool => $v !== null) + $extra;

        return new JsonResponse(
            $body,
            $status,
            ['Content-Type' => self::CONTENT_TYPE, 'Cache-Control' => 'no-store'] + $headers,
            JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE,
        );
    }

    /**
     * @return array{0: int, 1: string, 2: string, 3: string, 4: array<string, mixed>, 5: array<string, string>}
     */
    private static function describe(Throwable $e): array
    {
        return match (true) {
            $e instanceof ValidationException => [
                422, 'validation-failed', 'Validation failed',
                'One or more fields are invalid.',
                ['errors' => self::fieldErrors($e)], [],
            ],
            $e instanceof AuthenticationException => [
                401, 'unauthenticated', 'Authentication required',
                'Send a valid bearer token in the Authorization header.',
                [], ['WWW-Authenticate' => 'Bearer'],
            ],
            $e instanceof AuthorizationException => $e->status() === 404
                ? self::notFound()
                : [403, 'forbidden', 'Forbidden', 'You may not do that.', [], []],
            $e instanceof ModelNotFoundException, $e instanceof NotFoundHttpException => self::notFound(),
            $e instanceof MethodNotAllowedHttpException => [
                405, 'method-not-allowed', 'Method not allowed',
                'That method is not supported on this resource.',
                [], self::headers($e),
            ],
            $e instanceof PostTooLargeException => [
                413, 'payload-too-large', 'Payload too large',
                'The request body is larger than the server accepts.',
                [], [],
            ],
            $e instanceof HttpExceptionInterface => self::http($e),
            default => [
                500, 'internal-error', 'Internal server error',
                'Something went wrong. Quote the request id when you report it.',
                [], [],
            ],
        };
    }

    /**
     * @return array{0: int, 1: string, 2: string, 3: string, 4: array<string, mixed>, 5: array<string, string>}
     */
    private static function notFound(): array
    {
        return [404, 'not-found', 'Not found', 'No such resource.', [], []];
    }

    /**
     * @return array{0: int, 1: string, 2: string, 3: string, 4: array<string, mixed>, 5: array<string, string>}
     */
    private static function http(HttpExceptionInterface $e): array
    {
        $status = $e->getStatusCode();

        return match ($status) {
            403 => [403, 'forbidden', 'Forbidden', 'You may not do that.', [], []],
            404 => self::notFound(),
            415 => [415, 'unsupported-media-type', 'Unsupported media type', 'Send the body as application/json.', [], self::headers($e)],
            429 => [429, 'too-many-requests', 'Too many requests', 'Slow down and retry after the delay in Retry-After.', [], self::headers($e)],
            default => [
                $status,
                $status >= 500 ? 'server-error' : 'client-error',
                $status >= 500 ? 'Server error' : 'Request rejected',
                $status >= 500 ? 'The server could not complete the request.' : 'The request could not be processed.',
                [], self::headers($e),
            ],
        };
    }

    /**
     * Only the headers that carry meaning to a client (never a stack of internals).
     *
     * @return array<string, string>
     */
    private static function headers(HttpExceptionInterface $e): array
    {
        $out = [];
        foreach ($e->getHeaders() as $name => $value) {
            if (in_array(strtolower((string) $name), ['retry-after', 'allow', 'x-ratelimit-limit', 'x-ratelimit-remaining'], true)) {
                $out[(string) $name] = is_array($value)
                    ? implode(', ', array_map(static fn (mixed $v): string => is_scalar($v) ? (string) $v : '', $value))
                    : (is_scalar($value) ? (string) $value : '');
            }
        }

        return $out;
    }

    /**
     * @return list<array{field: string, message: string}>
     */
    private static function fieldErrors(ValidationException $e): array
    {
        /** @var array<string, list<string>> $byField */
        $byField = $e->errors();

        $errors = [];
        foreach ($byField as $field => $messages) {
            foreach ($messages as $message) {
                $errors[] = ['field' => (string) $field, 'message' => $message];
            }
        }

        return $errors;
    }
}
