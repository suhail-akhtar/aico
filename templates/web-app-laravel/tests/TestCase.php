<?php

declare(strict_types=1);

namespace Tests;

use Illuminate\Contracts\Console\Kernel;
use Illuminate\Foundation\Application;
use Illuminate\Foundation\Testing\TestCase as BaseTestCase;

abstract class TestCase extends BaseTestCase
{
    /**
     * Boots the app like the base class does, but reads `.env.example` instead of `.env`.
     * A clean clone or a CI runner has no `.env`, and Laravel's loader then emits a PHP
     * warning that PHPUnit counts (and `failOnWarning` turns into a failure). The example
     * file holds placeholders only, and everything a test depends on is set in
     * phpunit.xml, which wins because real environment variables are never overwritten.
     */
    public function createApplication(): Application
    {
        $app = require Application::inferBasePath().'/bootstrap/app.php';
        $app->loadEnvironmentFrom('.env.example');
        $app->make(Kernel::class)->bootstrap();

        return $app;
    }

    protected function setUp(): void
    {
        parent::setUp();

        // Blade's @vite needs the compiled asset manifest, which only exists after
        // `npm run build` (and Node is not in the PHP test image). Tests assert on
        // HTML and behaviour, not on bundles.
        $this->withoutVite();
    }
}
