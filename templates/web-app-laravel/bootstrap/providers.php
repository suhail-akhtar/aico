<?php

declare(strict_types=1);

use App\Features\Accounts\AccountsServiceProvider;
use App\Providers\AppServiceProvider;

return [
    AppServiceProvider::class,
    AccountsServiceProvider::class,
];
