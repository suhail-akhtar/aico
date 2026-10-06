<?php

declare(strict_types=1);

namespace App\Support\Console;

use Illuminate\Console\Attributes\Description;
use Illuminate\Console\Attributes\Signature;
use Illuminate\Console\Command;
use Symfony\Component\Process\Process;

/**
 * `php artisan app:dev`: one command that makes a fresh checkout runnable and
 * serves it. It is what AICO starts (`run.dev` in the template manifest) and
 * what `make dev` does without Docker Compose.
 *
 * Why a command and not a shell chain: an app runner starts ONE executable with
 * arguments (no `&&`), and the same line has to work natively and inside a
 * container. So the chain (create the SQLite file, migrate, seed, serve) lives here.
 *
 * Why PHP's built-in server directly and not `artisan serve`: `serve` deliberately
 * hides the process environment from the server it starts and makes it read `.env`
 * only, so the database, queue and mail settings that an app runner or Docker Compose
 * passes as environment variables would be silently ignored (found by running it: the
 * page tried to reach PostgreSQL while the migrations had run on SQLite).
 *
 * What it refuses: production. Seeding a demo account there would be a backdoor,
 * and the development server is not a production server.
 */
#[Signature('app:dev {--host=127.0.0.1 : Address to bind} {--port=8000 : Port to listen on} {--no-serve : Prepare the database and stop (used by the tests)}')]
#[Description('Prepare the local database (migrate + demo data) and serve the app for development')]
final class DevServerCommand extends Command
{
    public function handle(): int
    {
        if (app()->isProduction()) {
            $this->components->error('app:dev is for development. In production run the image (see docs/RELEASING.md).');

            return self::FAILURE;
        }

        $this->ensureSqliteFile();
        $this->call('migrate', ['--force' => true]);
        $this->call('db:seed', ['--force' => true]);

        if ($this->option('no-serve') === true) {
            return self::SUCCESS;
        }

        return $this->serve($this->stringOption('host', '127.0.0.1'), $this->stringOption('port', '8000'));
    }

    /** Runs `php -S` in front of public/ and blocks until it is stopped. Workers: PHP_CLI_SERVER_WORKERS. */
    private function serve(string $host, string $port): int
    {
        $router = is_file(base_path('server.php'))
            ? base_path('server.php')
            : base_path('vendor/laravel/framework/src/Illuminate/Foundation/resources/server.php');
        $process = new Process([PHP_BINARY, '-S', "{$host}:{$port}", $router], public_path());
        $process->setTimeout(null);

        // The line app runners wait for (template.json run.ready).
        $this->components->info("Server running on [http://{$host}:{$port}].");

        return $process->run(function (string $type, string $buffer): void {
            $this->output->write($buffer);
        });
    }

    /** SQLite refuses to create its own file through PDO when the directory is a relative path from elsewhere. */
    private function ensureSqliteFile(): void
    {
        if (config('database.default') !== 'sqlite') {
            return;
        }

        $path = config('database.connections.sqlite.database');
        if (! is_string($path) || $path === '' || $path === ':memory:') {
            return;
        }

        $absolute = str_starts_with($path, '/') || preg_match('#^[A-Za-z]:[\\\\/]#', $path) === 1 ? $path : base_path($path);
        if (! is_file($absolute)) {
            touch($absolute);
        }
    }

    private function stringOption(string $name, string $default): string
    {
        $value = $this->option($name);

        return is_string($value) && $value !== '' ? $value : $default;
    }
}
