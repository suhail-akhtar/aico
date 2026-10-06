<?php

declare(strict_types=1);

namespace App\Features\Items\Enums;

/** Where an item is in its life. A backed enum: the database stores the value, never the case name. */
enum ItemStatus: string
{
    case Open = 'open';
    case Done = 'done';

    public function toggled(): self
    {
        return match ($this) {
            self::Open => self::Done,
            self::Done => self::Open,
        };
    }

    public function label(): string
    {
        return match ($this) {
            self::Open => 'Open',
            self::Done => 'Done',
        };
    }
}
