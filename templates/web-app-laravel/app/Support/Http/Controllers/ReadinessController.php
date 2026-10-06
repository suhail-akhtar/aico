<?php

declare(strict_types=1);

namespace App\Support\Http\Controllers;

use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\DB;
use Throwable;

/**
 * `/readyz`: can this instance serve traffic right now? (It reaches the
 * database.) `/healthz` (Laravel's built-in route) only says the process is
 * up, which is what a liveness probe wants; a readiness probe wants this one,
 * so a load balancer stops sending traffic while the database is away
 * instead of restarting a perfectly healthy process. The failure detail goes to the log, not
 * to the caller.
 */
final class ReadinessController
{
    public function __invoke(): JsonResponse
    {
        try {
            DB::select('select 1');
        } catch (Throwable $e) {
            report($e);

            return response()->json(['status' => 'unavailable'], 503, ['Cache-Control' => 'no-store']);
        }

        return response()->json(['status' => 'ok'], 200, ['Cache-Control' => 'no-store']);
    }
}
