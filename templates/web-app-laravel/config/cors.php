<?php

declare(strict_types=1);

/*
 * Cross-origin access to the JSON API: an allow-list, empty by default.
 * Same-origin use (the web UI) needs no CORS at all. To let a browser app on
 * another origin call the API, list its exact origin(s):
 *
 *   CORS_ALLOWED_ORIGINS=https://app.example.com,https://admin.example.com
 *
 * Never "*": the API takes bearer tokens, and an any-origin policy is how a
 * token ends up in someone else's page. Credentials (cookies) are off.
 */

$origins = array_values(array_filter(array_map('trim', explode(',', (string) env('CORS_ALLOWED_ORIGINS', '')))));

return [
    'paths' => ['api/*'],

    'allowed_methods' => ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],

    'allowed_origins' => $origins,

    'allowed_origins_patterns' => [],

    'allowed_headers' => ['Authorization', 'Content-Type', 'Accept', 'X-Request-Id'],

    'exposed_headers' => ['X-Request-Id', 'Retry-After'],

    'max_age' => 600,

    'supports_credentials' => false,
];
