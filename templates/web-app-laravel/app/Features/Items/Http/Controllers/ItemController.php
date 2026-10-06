<?php

declare(strict_types=1);

namespace App\Features\Items\Http\Controllers;

use App\Features\Accounts\Models\User;
use App\Features\Items\Actions\CreateItem;
use App\Features\Items\Actions\DeleteItem;
use App\Features\Items\Actions\ItemInput;
use App\Features\Items\Actions\ListItems;
use App\Features\Items\Actions\UpdateItem;
use App\Features\Items\Enums\ItemStatus;
use App\Features\Items\Http\Requests\ListItemsRequest;
use App\Features\Items\Http\Requests\StoreItemRequest;
use App\Features\Items\Http\Requests\UpdateItemRequest;
use App\Features\Items\Http\Resources\ItemResource;
use App\Features\Items\Models\Item;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\AnonymousResourceCollection;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\Gate;

/**
 * JSON API for items. Thin on purpose: validate (form request), authorise
 * (policy), delegate (action), shape the output (resource).
 */
final class ItemController
{
    /**
     * List my items.
     *
     * Newest first, cursor-paginated: pass the `next_cursor` from `meta` as
     * `cursor` for the next page. `limit` is capped at 100.
     */
    public function index(ListItemsRequest $request, ListItems $list): AnonymousResourceCollection
    {
        $status = $request->enum('status', ItemStatus::class);
        $search = $request->filled('q') ? $request->string('q')->toString() : null;

        $page = $list->query(self::user($request), $search, $status)
            ->cursorPaginate($request->integer('limit', ListItemsRequest::DEFAULT_LIMIT))
            ->withQueryString();

        return ItemResource::collection($page);
    }

    /**
     * Create an item.
     */
    public function store(StoreItemRequest $request, CreateItem $create): JsonResponse
    {
        $item = $create->handle(self::user($request), ItemInput::fromValidated($request->validated()));

        return (new ItemResource($item))->response($request)->setStatusCode(201);
    }

    /**
     * Get one item.
     */
    public function show(Item $item): ItemResource
    {
        Gate::authorize('view', $item);

        return new ItemResource($item);
    }

    /**
     * Update an item (partial).
     */
    public function update(UpdateItemRequest $request, Item $item, UpdateItem $update): ItemResource
    {
        Gate::authorize('update', $item);

        return new ItemResource($update->handle($item, ItemInput::merge($item, $request->validated())));
    }

    /**
     * Delete an item.
     */
    public function destroy(Item $item, DeleteItem $delete): Response
    {
        Gate::authorize('delete', $item);
        $delete->handle($item);

        return response()->noContent();
    }

    private static function user(Request $request): User
    {
        $user = $request->user();
        assert($user instanceof User);

        return $user;
    }
}
