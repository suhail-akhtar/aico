<?php

// Runs INSIDE the built container (`docker exec -i <name> php < scripts/smoke.php`), so
// it needs nothing on the host. It plays a person: sign up in the browser form, land on
// the items page, then use the JSON API for the items feature. Any failed expectation
// exits 1.

declare(strict_types=1);

const BASE = 'http://127.0.0.1:8080';
$jar = tempnam('/tmp', 'jar');

/**
 * @param  list<string>  $headers
 * @return array{status: int, headers: string, body: string}
 */
function call(string $method, string $path, ?string $body = null, array $headers = [], bool $follow = false): array
{
    global $jar;
    $ch = curl_init(BASE.$path);
    curl_setopt_array($ch, [
        CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HEADER => true,
        CURLOPT_FOLLOWLOCATION => $follow,
        CURLOPT_COOKIEJAR => $jar,
        CURLOPT_COOKIEFILE => $jar,
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_TIMEOUT => 20,
    ]);
    if ($body !== null) {
        curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
    }
    $raw = (string) curl_exec($ch);
    $size = curl_getinfo($ch, CURLINFO_HEADER_SIZE);
    $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);

    return ['status' => $status, 'headers' => substr($raw, 0, $size), 'body' => substr($raw, $size)];
}

function expect(bool $ok, string $label, string $detail = ''): void
{
    echo ($ok ? 'ok: ' : 'FAIL: ').$label.PHP_EOL;
    if (! $ok) {
        echo $detail.PHP_EOL;
        exit(1);
    }
}

function token(string $html): string
{
    preg_match('/name="_token" value="([^"]+)"/', $html, $m);

    return $m[1] ?? '';
}

$r = call('GET', '/healthz');
expect($r['status'] === 200, 'GET /healthz -> 200', $r['headers']);

$r = call('GET', '/readyz');
expect($r['status'] === 200 && str_contains($r['body'], '"ok"'), 'GET /readyz -> 200 ok (database reachable)', $r['body']);

$r = call('GET', '/login');
expect($r['status'] === 200, 'GET /login -> 200');
expect(stripos($r['headers'], "content-security-policy: default-src 'none'") !== false, 'CSP header present');
expect(stripos($r['headers'], 'x-content-type-options: nosniff') !== false, 'nosniff header present');
expect(stripos($r['headers'], 'x-request-id:') !== false, 'request id header present');
expect(stripos($r['headers'], 'x-powered-by') === false && stripos($r['headers'], 'server:') === false, 'no X-Powered-By / Server header');

// Sign up through the real form (CSRF token, session cookie, redirect).
$r = call('GET', '/register');
$csrf = token($r['body']);
expect($csrf !== '', 'register form carries a CSRF token');

$email = 'smoke'.bin2hex(random_bytes(3)).'@example.test';
$password = 'a long passphrase for the smoke test';
$form = http_build_query(['_token' => $csrf, 'name' => 'Smoke Tester', 'email' => $email, 'password' => $password, 'password_confirmation' => $password]);
$r = call('POST', '/register', $form, ['Content-Type: application/x-www-form-urlencoded']);
expect($r['status'] === 302 && str_contains($r['headers'], '/items'), 'sign-up redirects to /items', $r['headers']);

$r = call('GET', '/items');
expect($r['status'] === 200 && str_contains($r['body'], 'Smoke Tester') && str_contains($r['body'], 'New item'), 'signed-in /items page renders with the user name');

// Without a CSRF token the same POST must be refused.
$r = call('POST', '/logout', '', ['Content-Type: application/x-www-form-urlencoded']);
expect($r['status'] === 419, 'POST without CSRF token -> 419', (string) $r['status']);

// The items feature over the JSON API.
$r = call('POST', '/api/v1/auth/tokens', json_encode(['email' => $email, 'password' => $password, 'device_name' => 'smoke']), ['Content-Type: application/json', 'Accept: application/json']);
expect($r['status'] === 201, 'POST /api/v1/auth/tokens -> 201', $r['body']);
$bearer = json_decode($r['body'], true)['data']['token'] ?? '';
$auth = ['Authorization: Bearer '.$bearer, 'Accept: application/json', 'Content-Type: application/json'];

$r = call('GET', '/api/v1/items', null, ['Accept: application/json']);
expect($r['status'] === 401 && str_contains($r['headers'], 'application/problem+json'), 'API without token -> 401 problem+json');

$r = call('POST', '/api/v1/items', json_encode(['title' => 'Smoke test item', 'notes' => 'created by smoke.php']), $auth);
expect($r['status'] === 201, 'POST /api/v1/items -> 201', $r['body']);
$id = json_decode($r['body'], true)['data']['id'] ?? '';

$r = call('GET', '/api/v1/items', null, $auth);
expect($r['status'] === 200 && str_contains($r['body'], 'Smoke test item'), 'GET /api/v1/items lists it');

$r = call('POST', '/api/v1/items', json_encode(['title' => '']), $auth);
expect($r['status'] === 422 && str_contains($r['body'], 'validation-failed'), 'invalid item -> 422 problem details');

$r = call('GET', '/items');
expect(str_contains($r['body'], 'Smoke test item'), 'the item shows on the web page too (same data, same owner)');

$r = call('DELETE', '/api/v1/items/'.$id, null, $auth);
expect($r['status'] === 204, 'DELETE /api/v1/items/{id} -> 204');

$r = call('GET', '/docs/api.json', null, ['Accept: application/json']);
expect($r['status'] === 200 && str_contains($r['body'], '"openapi"'), 'OpenAPI document served');

echo 'smoke.php: all checks passed'.PHP_EOL;
