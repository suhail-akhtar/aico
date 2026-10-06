<?php

declare(strict_types=1);

use App\Features\Items\Http\Livewire\ItemsPage;
use Dedoc\Scramble\Scramble;
use Illuminate\Support\Facades\Route;

// No closures in route files: `php artisan route:cache` (run at container start) cannot serialise them.
Route::view('/', 'welcome')->name('home');

Route::middleware('auth')->group(function (): void {
    Route::livewire('/items', ItemsPage::class)->name('items');
});

// The OpenAPI document (generated from the code). Allowed in local development;
// elsewhere only when API_DOCS_ENABLED=true (the `viewApiDocs` gate).
Scramble::registerJsonSpecificationRoute('docs/api.json')->name('scramble.docs.document');
