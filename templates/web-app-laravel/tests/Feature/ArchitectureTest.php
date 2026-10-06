<?php

declare(strict_types=1);

// The structure documented in docs/ARCHITECTURE.md, enforced. A violation here
// is the first sign the layering is eroding; fix the code, not the test.

arch('every class declares strict types')
    ->expect('App')
    ->toUseStrictTypes();

arch('no debugging leftovers')
    ->expect(['dd', 'dump', 'ray', 'var_dump', 'print_r', 'die', 'exit'])
    ->not->toBeUsed();

arch('actions know nothing about HTTP or Livewire')
    ->expect('App\Features\Items\Actions')
    ->not->toUse(['Illuminate\Http', 'Livewire', 'Illuminate\Support\Facades\Request', 'Illuminate\Support\Facades\Auth']);

arch('models know nothing about HTTP')
    ->expect('App\Features\Items\Models')
    ->not->toUse(['Illuminate\Http', 'Livewire', 'App\Features\Items\Http']);

arch('controllers do not touch the database directly')
    ->expect('App\Features\Items\Http\Controllers')
    ->not->toUse(['Illuminate\Support\Facades\DB', 'Illuminate\Database\Eloquent\Model']);

arch('accounts do not depend on the features built on top of them')
    ->expect('App\Features\Accounts')
    ->not->toUse('App\Features\Items');

arch('the shared kernel does not depend on features')
    ->expect('App\Support')
    ->not->toUse('App\Features');

arch('policies are final and stateless')
    ->expect('App\Features\Items\Policies')
    ->toBeFinal();

arch('enums are backed')
    ->expect('App\Features\Items\Enums')
    ->toBeEnums();

arch('form requests extend FormRequest')
    ->expect('App\Features\Items\Http\Requests\StoreItemRequest')
    ->toExtend('Illuminate\Foundation\Http\FormRequest');

it('has no inline style attributes, unescaped Blade output or inline event handlers in views', function (): void {
    $files = new RecursiveIteratorIterator(new RecursiveDirectoryIterator(resource_path('views'), FilesystemIterator::SKIP_DOTS));

    foreach ($files as $file) {
        $path = (string) $file;
        $source = (string) file_get_contents($path);

        expect($source)->not->toMatch('/\sstyle\s*=/i', "inline style in {$path} (the CSP forbids it)")
            ->not->toContain('{!!', "unescaped output in {$path}")
            ->not->toMatch('/\son[a-z]+\s*=\s*["\']/i', "inline event handler in {$path}");
    }
});
