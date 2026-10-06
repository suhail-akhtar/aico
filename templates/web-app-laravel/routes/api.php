<?php

declare(strict_types=1);

use App\Features\Accounts\Http\Controllers\ApiTokenController;
use App\Features\Items\Http\Controllers\ItemController;
use Illuminate\Support\Facades\Route;

// JSON API, versioned in the URL. Bearer tokens (Sanctum), never cookies, so
// there is no CSRF surface here. Changes within v1 are additive only.
Route::prefix('v1')->name('api.v1.')->group(function (): void {
    Route::post('auth/tokens', [ApiTokenController::class, 'store'])
        ->middleware('throttle:tokens')
        ->name('tokens.store');

    Route::middleware(['auth:sanctum', 'throttle:api'])->group(function (): void {
        Route::delete('auth/tokens/current', [ApiTokenController::class, 'destroy'])->name('tokens.destroy');
        // PATCH only (partial update). apiResource would also map PUT, which this API does not offer.
        Route::apiResource('items', ItemController::class)->except('update');
        Route::patch('items/{item}', [ItemController::class, 'update'])->name('items.update');
    });
});
