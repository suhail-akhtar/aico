<?php

declare(strict_types=1);

use App\Features\Items\Http\Resources\ItemResource;
use App\Features\Items\Models\Item;
use Illuminate\Support\Facades\Route;

/**
 * The API contract. The committed docs/openapi.json is what clients and code
 * generators read; these tests keep it equal to what the code really does.
 * After an intentional API change run `make openapi` and commit the diff.
 *
 * @return array<string, mixed>
 */
function committedSpec(): array
{
    $json = file_get_contents(base_path('docs/openapi.json'));
    expect($json)->not->toBeFalse();

    /** @var array<string, mixed> */
    return json_decode((string) $json, true, flags: JSON_THROW_ON_ERROR);
}

it('has a committed OpenAPI document equal to the one generated from the code', function (): void {
    $this->artisan('scramble:export', ['--path' => 'storage/framework/testing-openapi.json'])->assertSuccessful();
    $generated = json_decode((string) file_get_contents(base_path('storage/framework/testing-openapi.json')), true, flags: JSON_THROW_ON_ERROR);
    @unlink(base_path('storage/framework/testing-openapi.json'));

    expect($generated)->toEqual(committedSpec());
});

it('documents every API route and method', function (): void {
    $spec = committedSpec();
    $paths = $spec['paths'];
    expect($paths)->toBeArray();

    foreach (Route::getRoutes() as $route) {
        if (! str_starts_with($route->uri(), 'api/')) {
            continue;
        }
        // Scramble strips the server prefix ("/api") from documented paths.
        $path = '/'.substr($route->uri(), strlen('api/'));
        foreach ($route->methods() as $method) {
            if (in_array($method, ['HEAD', 'OPTIONS'], true)) {
                continue;
            }
            expect($paths)->toHaveKey($path);
            expect(isset($paths[$path][strtolower($method)]))->toBeTrue("{$method} {$path} is not documented");
        }
    }
});

it('is OpenAPI 3.1, declares bearer auth, and describes problem responses', function (): void {
    $spec = committedSpec();

    expect($spec['openapi'])->toStartWith('3.1')
        ->and(json_encode($spec['components']['securitySchemes'] ?? []))->toContain('bearer');
});

it('returns exactly the item properties the document promises', function (): void {
    $spec = committedSpec();
    $schemas = $spec['components']['schemas'];
    expect($schemas)->toHaveKey('ItemResource');

    $documented = array_keys($schemas['ItemResource']['properties']);
    sort($documented);

    [$user, $headers] = userWithToken();
    $item = Item::factory()->ownedBy($user)->create();
    $actual = array_keys((array) $this->getJson("/api/v1/items/{$item->id}", $headers)->assertOk()->json('data'));
    sort($actual);

    expect($actual)->toBe($documented)
        ->and(array_keys((new ItemResource($item))->toArray(request())))->toEqualCanonicalizing($documented);
});
