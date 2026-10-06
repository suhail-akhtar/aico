<?php

declare(strict_types=1);

namespace App\Features\Accounts\Http\Responses;

use Illuminate\Contracts\Support\Responsable;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Password;
use Laravel\Fortify\Contracts\FailedPasswordResetLinkRequestResponse;

/**
 * "We emailed a reset link", even when no account has that address.
 *
 * Fortify's default answers "we can't find a user with that email", which lets
 * anyone test which addresses are registered (account enumeration, OWASP
 * ASVS 6.x). Only throttling is still reported: it says nothing about accounts.
 */
final class GenericResetLinkResponse implements FailedPasswordResetLinkRequestResponse, Responsable
{
    public function __construct(private readonly string $status) {}

    /**
     * @param  Request  $request
     */
    public function toResponse($request): JsonResponse|RedirectResponse
    {
        $throttled = $this->status === Password::RESET_THROTTLED;
        $message = trans($throttled ? $this->status : Password::RESET_LINK_SENT);

        if ($request->wantsJson()) {
            return new JsonResponse(['message' => $message], $throttled ? 429 : 200);
        }

        return $throttled
            ? back()->withInput($request->only('email'))->withErrors(['email' => $message])
            : back()->with('status', $message);
    }
}
