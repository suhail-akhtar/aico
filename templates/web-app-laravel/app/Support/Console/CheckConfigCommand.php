<?php

declare(strict_types=1);

namespace App\Support\Console;

use App\Support\Config\EnvironmentGuard;
use Illuminate\Console\Attributes\Description;
use Illuminate\Console\Attributes\Signature;
use Illuminate\Console\Command;

/** `php artisan app:check-config`: the container entrypoint runs this before starting, so bad config stops the deploy. */
#[Signature('app:check-config')]
#[Description('Fail (exit 1) if the environment configuration is missing or unsafe')]
final class CheckConfigCommand extends Command
{
    public function handle(EnvironmentGuard $guard): int
    {
        $errors = $guard->errors();

        foreach ($errors as $error) {
            $this->components->error($error);
        }

        if ($errors === []) {
            $this->components->info('Configuration is valid.');
        }

        return $errors === [] ? self::SUCCESS : self::FAILURE;
    }
}
