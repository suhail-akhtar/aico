<?php

declare(strict_types=1);

namespace App\Features\Accounts\Http\Controllers;

use App\Features\Accounts\Http\Requests\CreateTokenRequest;
use App\Features\Accounts\Models\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\Hash;
use Illuminate\Validation\ValidationException;
use Laravel\Sanctum\PersonalAccessToken;

/**
 * Personal access tokens for API clients (Sanctum). A browser never needs one:
 * the web UI uses the session cookie. The token is shown once and stored hashed.
 */
final class ApiTokenController
{
    /**
     * Exchange credentials for a bearer token.
     *
     * Throttled by the `tokens` limiter (email + IP). A wrong email and a wrong
     * password give the same answer, and an unknown email still pays for one
     * hash, so neither the message nor the timing says which accounts exist.
     *
     * @unauthenticated
     */
    public function store(CreateTokenRequest $request): JsonResponse
    {
        $password = $request->string('password')->toString();
        $user = User::query()->where('email', mb_strtolower($request->string('email')->toString()))->first();

        if ($user === null) {
            Hash::make($password);
        }

        if ($user === null || ! Hash::check($password, $user->password)) {
            throw ValidationException::withMessages(['email' => [trans('auth.failed')]]);
        }

        $ttl = config('sanctum.expiration');
        $token = $user->createToken(
            $request->string('device_name')->toString(),
            ['*'],
            is_int($ttl) && $ttl > 0 ? now()->addMinutes($ttl) : null,
        );

        return response()->json([
            'data' => [
                'token' => $token->plainTextToken,
                'type' => 'Bearer',
                'expires_at' => $token->accessToken->expires_at?->toIso8601String(),
            ],
        ], 201);
    }

    /**
     * Revoke the token used for this request.
     */
    public function destroy(Request $request): Response
    {
        $token = $request->user()?->currentAccessToken();

        if ($token instanceof PersonalAccessToken) {
            $token->delete();
        }

        return response()->noContent();
    }
}
