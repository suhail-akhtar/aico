<?php

declare(strict_types=1);

use App\Features\Accounts\Models\User;
use App\Features\Items\Enums\ItemStatus;
use App\Features\Items\Models\Item;
use Illuminate\Support\Facades\RateLimiter;

const PROBLEM = 'application/problem+json';

it('creates an item for the signed-in user and returns 201', function (): void {
    [$user, $headers] = userWithToken();

    $response = $this->postJson('/api/v1/items', ['title' => 'Buy milk', 'notes' => '2 litres'], $headers)
        ->assertCreated()
        ->assertJsonPath('data.title', 'Buy milk')
        ->assertJsonPath('data.status', 'open');

    $id = $response->json('data.id');
    expect(Item::query()->findOrFail($id)->user_id)->toBe($user->id);
});

it('ignores a user_id (or any unknown field) sent by the client', function (): void {
    [$user, $headers] = userWithToken();
    $other = User::factory()->create();

    $id = $this->postJson('/api/v1/items', ['title' => 'Mine', 'user_id' => $other->id, 'id' => 'x'], $headers)
        ->assertCreated()->json('data.id');

    expect(Item::query()->findOrFail($id)->user_id)->toBe($user->id);
});

it('lists only my items, newest first', function (): void {
    [$user, $headers] = userWithToken();
    $mine = Item::factory()->ownedBy($user)->count(3)->create();
    Item::factory()->count(2)->create();

    $ids = collect($this->getJson('/api/v1/items', $headers)->assertOk()->json('data'))->pluck('id');

    expect($ids)->toHaveCount(3)
        ->and($ids->sort()->values()->all())->toBe($mine->pluck('id')->sort()->values()->all());
});

it('paginates with a cursor and caps the page size', function (): void {
    [$user, $headers] = userWithToken();
    Item::factory()->ownedBy($user)->count(5)->create();

    $first = $this->getJson('/api/v1/items?limit=2', $headers)->assertOk();
    expect($first->json('data'))->toHaveCount(2)
        ->and($first->json('meta.next_cursor'))->not->toBeNull();

    $second = $this->getJson('/api/v1/items?limit=2&cursor='.urlencode((string) $first->json('meta.next_cursor')), $headers)->assertOk();
    expect($second->json('data'))->toHaveCount(2)
        ->and(array_intersect(array_column($first->json('data'), 'id'), array_column($second->json('data'), 'id')))->toBe([]);

    $this->getJson('/api/v1/items?limit=1000', $headers)->assertStatus(422)->assertHeader('Content-Type', PROBLEM);
});

it('filters by status and searches titles, treating LIKE wildcards literally', function (): void {
    [$user, $headers] = userWithToken();
    Item::factory()->ownedBy($user)->create(['title' => 'Pay rent']);
    Item::factory()->ownedBy($user)->done()->create(['title' => 'Pay tax']);
    Item::factory()->ownedBy($user)->create(['title' => '100% done']);

    expect($this->getJson('/api/v1/items?status=done', $headers)->json('data'))->toHaveCount(1)
        ->and($this->getJson('/api/v1/items?q=pay', $headers)->json('data'))->toHaveCount(2)
        ->and($this->getJson('/api/v1/items?q='.urlencode('%'), $headers)->json('data'))->toHaveCount(1)
        ->and($this->getJson('/api/v1/items?q='.urlencode('_'), $headers)->json('data'))->toHaveCount(0);
});

it('shows, updates (partially) and deletes my item', function (): void {
    [$user, $headers] = userWithToken();
    $item = Item::factory()->ownedBy($user)->create(['title' => 'Old', 'notes' => 'n']);

    $this->getJson("/api/v1/items/{$item->id}", $headers)->assertOk()->assertJsonPath('data.title', 'Old');

    $this->patchJson("/api/v1/items/{$item->id}", ['status' => 'done'], $headers)
        ->assertOk()->assertJsonPath('data.status', 'done')->assertJsonPath('data.title', 'Old');

    $this->patchJson("/api/v1/items/{$item->id}", ['title' => 'New', 'notes' => null], $headers)
        ->assertOk()->assertJsonPath('data.title', 'New')->assertJsonPath('data.notes', null);

    $this->deleteJson("/api/v1/items/{$item->id}", [], $headers)->assertNoContent();
    $this->assertDatabaseMissing('items', ['id' => $item->id]);
});

it('answers 404, not 403, for another user\'s item on every verb', function (): void {
    [, $headers] = userWithToken();
    $theirs = Item::factory()->create(['title' => 'Secret plans']);

    $this->getJson("/api/v1/items/{$theirs->id}", $headers)->assertNotFound()->assertHeader('Content-Type', PROBLEM)->assertJsonPath('code', 'not-found');
    $this->patchJson("/api/v1/items/{$theirs->id}", ['title' => 'pwned'], $headers)->assertNotFound();
    $this->deleteJson("/api/v1/items/{$theirs->id}", [], $headers)->assertNotFound();

    expect($theirs->fresh()?->title)->toBe('Secret plans');
});

it('answers 404 for an id that does not exist', function (): void {
    [, $headers] = userWithToken();

    $this->getJson('/api/v1/items/01ARZ3NDEKTSV4RRFFQ69G5FAV', $headers)->assertNotFound()->assertHeader('Content-Type', PROBLEM);
});

it('rejects a missing, malformed or revoked bearer token with a 401 problem', function (): void {
    $this->getJson('/api/v1/items')
        ->assertUnauthorized()
        ->assertHeader('Content-Type', PROBLEM)
        ->assertHeader('WWW-Authenticate', 'Bearer')
        ->assertJsonPath('code', 'unauthenticated');

    $this->getJson('/api/v1/items', ['Authorization' => 'Bearer not-a-real-token'])->assertUnauthorized();

    [$user, $headers] = userWithToken();
    $user->tokens()->delete();
    $this->getJson('/api/v1/items', $headers)->assertUnauthorized();
});

it('rejects an expired token', function (): void {
    [$user, $headers] = userWithToken();
    $this->travel(31)->days();

    $this->getJson('/api/v1/items', $headers)->assertUnauthorized();
    expect($user->tokens()->count())->toBe(1);
});

it('returns field-level validation problems', function (): void {
    [, $headers] = userWithToken();

    $response = $this->postJson('/api/v1/items', ['title' => '', 'status' => 'archived'], $headers)
        ->assertStatus(422)
        ->assertHeader('Content-Type', PROBLEM)
        ->assertJsonPath('type', 'urn:problem:validation-failed')
        ->assertJsonPath('status', 422);

    $fields = array_column($response->json('errors'), 'field');
    expect($fields)->toContain('title')->toContain('status');
});

it('enforces maximum lengths and the type of every field', function (): void {
    [, $headers] = userWithToken();

    $this->postJson('/api/v1/items', ['title' => str_repeat('a', 121)], $headers)->assertStatus(422);
    $this->postJson('/api/v1/items', ['title' => 'ok', 'notes' => str_repeat('a', 2001)], $headers)->assertStatus(422);
    $this->postJson('/api/v1/items', ['title' => ['array']], $headers)->assertStatus(422);
    $this->postJson('/api/v1/items', ['title' => 'ok', 'notes' => ['x']], $headers)->assertStatus(422);
});

it('does not let a blank title through a PATCH', function (): void {
    [$user, $headers] = userWithToken();
    $item = Item::factory()->ownedBy($user)->create();

    $this->patchJson("/api/v1/items/{$item->id}", ['title' => ''], $headers)->assertStatus(422);
});

it('stores hostile strings as inert data', function (string $payload): void {
    [$user, $headers] = userWithToken();

    $id = $this->postJson('/api/v1/items', ['title' => $payload], $headers)->assertCreated()->json('data.id');

    expect(Item::query()->findOrFail($id)->title)->toBe($payload)
        ->and(Item::query()->whereBelongsTo($user, 'owner')->count())->toBe(1);
    // A search containing SQL must not error or leak other users' rows.
    $this->getJson('/api/v1/items?q='.urlencode($payload), $headers)->assertOk();
})->with([
    "'; DROP TABLE items; --",
    "' OR '1'='1",
    '<script>alert(1)</script>',
    '${jndi:ldap://x}',
]);

it('refuses form-encoded bodies on write endpoints with 415', function (): void {
    [, $headers] = userWithToken();

    $this->call('POST', '/api/v1/items', ['title' => 'x'], [], [], [
        'HTTP_AUTHORIZATION' => $headers['Authorization'],
        'HTTP_ACCEPT' => 'application/json',
        'CONTENT_TYPE' => 'application/x-www-form-urlencoded',
    ], 'title=x')
        ->assertStatus(415)
        ->assertHeader('Content-Type', PROBLEM)
        ->assertJsonPath('code', 'unsupported-media-type');
});

it('rejects a request body larger than post_max_size with 413', function (): void {
    [, $headers] = userWithToken();
    $limit = (int) ini_parse_quantity((string) ini_get('post_max_size'));
    $limit = $limit > 0 ? $limit : 8 * 1024 * 1024;

    $this->call('POST', '/api/v1/items', [], [], [], [
        'HTTP_AUTHORIZATION' => $headers['Authorization'],
        'HTTP_ACCEPT' => 'application/json',
        'CONTENT_TYPE' => 'application/json',
        'CONTENT_LENGTH' => (string) ($limit + 1),
    ], '{}')
        ->assertStatus(413)
        ->assertHeader('Content-Type', PROBLEM);
});

it('rate limits the API per token and says when to retry', function (): void {
    [, $headers] = userWithToken();

    foreach (range(1, 60) as $_) {
        $this->getJson('/api/v1/items', $headers)->assertOk();
    }

    $this->getJson('/api/v1/items', $headers)
        ->assertStatus(429)
        ->assertHeader('Content-Type', PROBLEM)
        ->assertHeader('Retry-After')
        ->assertJsonPath('code', 'too-many-requests');

    RateLimiter::clear('api');
});

it('puts the request id on the response and in problem bodies', function (): void {
    [, $headers] = userWithToken();

    $ok = $this->getJson('/api/v1/items', $headers + ['X-Request-Id' => 'req-12345678'])->assertOk();
    expect($ok->headers->get('X-Request-Id'))->toBe('req-12345678');

    $problem = $this->getJson('/api/v1/items/nope', $headers)->assertNotFound();
    expect($problem->json('request_id'))->toBe($problem->headers->get('X-Request-Id'))
        ->and($problem->json('instance'))->toStartWith('urn:request:');
});

it('replaces an unsafe incoming request id instead of echoing it', function (): void {
    [, $headers] = userWithToken();

    $response = $this->getJson('/api/v1/items', $headers + ['X-Request-Id' => "bad id\r\nSet-Cookie: x=1"])->assertOk();

    expect($response->headers->get('X-Request-Id'))->toMatch('/^[0-9a-f-]{36}$/');
});

it('never exposes the exception message of a server error', function (): void {
    [, $headers] = userWithToken();
    $this->app->make('router')->get('api/v1/boom', fn () => throw new RuntimeException('database password is hunter2'))
        ->middleware(['auth:sanctum']);

    $response = $this->getJson('/api/v1/boom', $headers)->assertStatus(500)->assertHeader('Content-Type', PROBLEM);

    expect($response->getContent())->not->toContain('hunter2')
        ->and($response->json('code'))->toBe('internal-error');
});

it('answers 405 with an Allow header and a problem body', function (): void {
    [, $headers] = userWithToken();

    $this->putJson('/api/v1/auth/tokens', [], $headers)->assertStatus(405)->assertHeader('Content-Type', PROBLEM)->assertHeader('Allow');
});

it('counts a done item in the right status bucket', function (): void {
    [$user, $headers] = userWithToken();
    Item::factory()->ownedBy($user)->done()->create();

    expect(Item::query()->where('status', ItemStatus::Done)->count())->toBe(1)
        ->and($this->getJson('/api/v1/items?status=open', $headers)->json('data'))->toBe([]);
});

it('refuses control characters (a NUL byte would be silently truncated by PostgreSQL)', function (): void {
    [, $headers] = userWithToken();

    $this->postJson('/api/v1/items', ['title' => "null\u{0000}byte"], $headers)->assertStatus(422);
    $this->postJson('/api/v1/items', ['title' => "line\nbreak"], $headers)->assertStatus(422);
    $this->postJson('/api/v1/items', ['title' => 'ok', 'notes' => "bell\u{0007}"], $headers)->assertStatus(422);
    // Notes may contain newlines and tabs.
    $this->postJson('/api/v1/items', ['title' => 'ok', 'notes' => "two\nlines\tand a tab"], $headers)->assertCreated();
});
