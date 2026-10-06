<?php

declare(strict_types=1);

namespace App\Features\Items\Http\Requests;

use App\Features\Items\Enums\ItemStatus;
use Illuminate\Validation\Rule;

/**
 * The validation rules for an item, in one place. The API's form requests and
 * the Livewire form both read them, so the two front doors cannot drift apart.
 */
final class ItemRules
{
    public const TITLE_MAX = 120;

    public const NOTES_MAX = 2000;

    /**
     * Control characters are refused, not stripped. A NUL byte is the reason: SQLite stores it,
     * PostgreSQL cannot, and the driver silently cuts the string at it (found by running the
     * suite on both). Titles take no control characters at all; notes keep tab, CR and LF.
     */
    public const CONTROL_CHARS = '/[\x00-\x1F\x7F]/';

    public const CONTROL_CHARS_EXCEPT_NEWLINES = '/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/';

    /**
     * @return array<string, list<mixed>>
     */
    public static function rules(): array
    {
        return [
            'title' => ['required', 'string', 'max:'.self::TITLE_MAX, 'not_regex:'.self::CONTROL_CHARS],
            'notes' => ['nullable', 'string', 'max:'.self::NOTES_MAX, 'not_regex:'.self::CONTROL_CHARS_EXCEPT_NEWLINES],
            'status' => ['sometimes', Rule::enum(ItemStatus::class)],
        ];
    }

    /**
     * The same rules for a partial update: every field optional, but a field
     * that is sent must still be valid. A title may not be blanked out.
     *
     * @return array<string, list<mixed>>
     */
    public static function partial(): array
    {
        $rules = self::rules();
        $rules['title'] = ['sometimes', ...$rules['title']];

        return $rules;
    }
}
