<?php

declare(strict_types=1);

namespace App\Features\Accounts\Rules;

use Illuminate\Validation\Rules\Password;

/**
 * One definition of "an acceptable password" for sign-up, reset and anything
 * added later. Length beats composition rules (NIST 800-63B, OWASP ASVS 5.0):
 * 12 to 128 characters, and in production not one found in a known breach
 * (the HIBP k-anonymity API: only a 5-character hash prefix leaves the server).
 */
final class PasswordRules
{
    public const MIN = 12;

    public const MAX = 128;

    /**
     * @return list<mixed>
     */
    public static function rules(): array
    {
        return ['required', 'string', self::default(), 'confirmed'];
    }

    public static function default(): Password
    {
        $rule = Password::min(self::MIN)->max(self::MAX);

        return app()->isProduction() ? $rule->uncompromised() : $rule;
    }
}
