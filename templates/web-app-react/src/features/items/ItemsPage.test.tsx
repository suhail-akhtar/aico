import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { renderApp, seedItems } from '../../test/render';
import { mockStack, server } from '../../test/server';

const ITEMS = '*/api/v1/items';

async function openItems(path = '/items') {
  const app = await renderApp(path);
  await screen.findByRole('heading', { name: 'Items', level: 1 });
  return app;
}

/** Forward to the mock gateway after a pause, so a test can look at the optimistic state. */
const slowly =
  (ms: number) =>
  async ({ request }: { request: Request }) => {
    await delay(ms);
    return (await mockStack.handle(request)) as Response;
  };

describe('items list', () => {
  it('shows the empty state with a way to create the first item', async () => {
    const user = userEvent.setup();
    await openItems();
    expect(await screen.findByRole('heading', { name: 'No items yet' })).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'New item' })[0] as HTMLElement);
    expect(await screen.findByRole('dialog', { name: 'New item' })).toBeInTheDocument();
  });

  it("lists the caller's items with their quantity and a count", async () => {
    await seedItems(['Pen', 'Paper']);
    await openItems();
    const list = await screen.findByRole('list', { name: 'Your items' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Paper');
    expect(rows[1]).toHaveTextContent('Pen');
    expect(rows[0]).toHaveTextContent('Quantity 1');
    expect(screen.getByText('2 items')).toBeInTheDocument();
  });

  it('loads the next page on demand and then hides the button', async () => {
    const user = userEvent.setup();
    await seedItems(Array.from({ length: 25 }, (_, n) => `Item ${String(n + 1).padStart(2, '0')}`));
    await openItems();
    const list = await screen.findByRole('list', { name: 'Your items' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(20);
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(25));
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('says so, and offers a retry, when the list cannot be loaded', async () => {
    const user = userEvent.setup();
    let failing = true;
    server.use(
      http.get(ITEMS, async ({ request }) =>
        failing
          ? HttpResponse.json({ title: 'Internal Server Error', status: 500 }, { status: 500 })
          : ((await mockStack.handle(request)) as Response),
      ),
    );
    await renderApp('/items');
    expect(await screen.findByRole('alert')).toHaveTextContent('The items could not be loaded.');
    failing = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'No items yet' })).toBeInTheDocument();
  });

  it('explains a network failure plainly', async () => {
    server.use(http.get(ITEMS, () => HttpResponse.error()));
    await renderApp('/items');
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be reached');
  });
});

describe('creating an item', () => {
  it('validates before sending, then shows the new item and confirms it', async () => {
    const user = userEvent.setup();
    await openItems();
    await user.click(
      (await screen.findAllByRole('button', { name: 'New item' }))[0] as HTMLElement,
    );
    const dialog = await screen.findByRole('dialog', { name: 'New item' });

    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    const name = within(dialog).getByLabelText('Name');
    expect(await within(dialog).findByText('Enter a name.')).toBeInTheDocument();
    expect(name).toHaveAttribute('aria-invalid', 'true');
    await waitFor(() => expect(name).toHaveFocus());

    await user.type(name, 'Stapler');
    await user.type(within(dialog).getByLabelText('Description'), 'Red, heavy');
    await user.clear(within(dialog).getByLabelText('Quantity'));
    await user.type(within(dialog).getByLabelText('Quantity'), '4');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const list = await screen.findByRole('list', { name: 'Your items' });
    expect(within(list).getByText('Stapler')).toBeInTheDocument();
    expect(within(list).getByText('Red, heavy')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Item created.');
  });

  it('shows the item at once (marked busy) while the server is still answering', async () => {
    const user = userEvent.setup();
    server.use(http.post(ITEMS, slowly(300)));
    await seedItems(['Existing']);
    await openItems();
    await user.click(screen.getAllByRole('button', { name: 'New item' })[0] as HTMLElement);
    const dialog = await screen.findByRole('dialog', { name: 'New item' });
    await user.type(within(dialog).getByLabelText('Name'), 'Optimistic');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    const row = await screen.findByText('Optimistic');
    const item = row.closest('li');
    expect(item).toHaveAttribute('aria-busy', 'true');
    expect(
      within(item as HTMLElement).getByRole('button', { name: 'Edit Optimistic' }),
    ).toBeDisabled();
    await waitFor(() =>
      expect(screen.getByText('Optimistic').closest('li')).not.toHaveAttribute('aria-busy'),
    );
  });

  it("keeps the dialog open, maps the server's field error and removes the optimistic row", async () => {
    const user = userEvent.setup();
    server.use(
      http.post(ITEMS, () =>
        HttpResponse.json(
          {
            title: 'Unprocessable Content',
            status: 422,
            errors: [{ field: 'name', message: 'Name already taken.' }],
          },
          { status: 422, headers: { 'content-type': 'application/problem+json' } },
        ),
      ),
    );
    await openItems();
    await user.click(
      (await screen.findAllByRole('button', { name: 'New item' }))[0] as HTMLElement,
    );
    const dialog = await screen.findByRole('dialog', { name: 'New item' });
    await user.type(within(dialog).getByLabelText('Name'), 'Duplicate');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(await within(dialog).findByText('Name already taken.')).toBeInTheDocument();
    expect(within(dialog).getByRole('alert')).toHaveTextContent('The item could not be saved.');
    expect(dialog).toHaveAttribute('open');
    await waitFor(() =>
      expect(screen.queryByText('Duplicate', { selector: 'p' })).not.toBeInTheDocument(),
    );
  });

  it("shows a server error that names no field as the form's message", async () => {
    const user = userEvent.setup();
    server.use(
      http.post(ITEMS, () =>
        HttpResponse.json(
          { title: 'Bad Gateway', status: 502, detail: 'The API is restarting.' },
          { status: 502 },
        ),
      ),
    );
    await openItems();
    await user.click(
      (await screen.findAllByRole('button', { name: 'New item' }))[0] as HTMLElement,
    );
    const dialog = await screen.findByRole('dialog', { name: 'New item' });
    await user.type(within(dialog).getByLabelText('Name'), 'Anything');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('The API is restarting.');
  });

  it('opens from the N shortcut, but never while typing in a field', async () => {
    const user = userEvent.setup();
    await openItems();
    await screen.findByRole('heading', { name: 'No items yet' });
    await user.keyboard('n');
    const dialog = await screen.findByRole('dialog', { name: 'New item' });
    await user.type(within(dialog).getByLabelText('Name'), 'nnn');
    expect(within(dialog).getByLabelText('Name')).toHaveValue('nnn');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});

describe('editing an item', () => {
  it('prefills the form, saves the change and updates the row', async () => {
    const user = userEvent.setup();
    await seedItems(['Pen']);
    await openItems();
    await user.click(await screen.findByRole('button', { name: 'Edit Pen' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit item' });
    const name = within(dialog).getByLabelText('Name');
    expect(name).toHaveValue('Pen');
    await user.clear(name);
    await user.type(name, 'Fountain pen');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByText('Fountain pen')).toBeInTheDocument();
    expect(screen.queryByText('Pen', { exact: true })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Item saved.');
  });

  it('opens straight from a link, even to an item that is not on the first page', async () => {
    await seedItems(Array.from({ length: 22 }, (_, n) => `Item ${String(n + 1).padStart(2, '0')}`));
    mockStack.impersonate('dev@example.com');
    const oldest = (await (
      await mockStack.handle(new Request('http://localhost:3000/api/v1/items?limit=100'))
    )?.json()) as {
      items: Array<{ id: string; name: string }>;
    };
    const target = oldest.items.at(-1) as { id: string; name: string };
    await renderApp(`/items?dialog=edit&id=${target.id}`);
    const dialog = await screen.findByRole('dialog', { name: 'Edit item' });
    expect(within(dialog).getByLabelText('Name')).toHaveValue(target.name);
  });

  it('closes the dialog when the linked item does not exist', async () => {
    const { router } = await renderApp(
      '/items?dialog=edit&id=5c4b5d84-4ac0-45a1-8b8a-2b6bf0a5c2de',
    );
    await screen.findByRole('heading', { name: 'Items', level: 1 });
    await waitFor(() => expect(router.state.location.search).toEqual({}));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('deleting an item', () => {
  it('asks first, focuses the safe choice, then removes the row immediately', async () => {
    const user = userEvent.setup();
    server.use(http.delete(`${ITEMS}/:id`, slowly(300)));
    await seedItems(['Pen', 'Paper']);
    await openItems();
    await user.click(await screen.findByRole('button', { name: 'Delete Pen' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete this item?' });
    expect(within(dialog).getByText(/Pen will be removed/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();

    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    // Gone from the screen before the (slow) server has answered.
    await waitFor(() =>
      expect(screen.queryByText('Pen', { selector: 'p' })).not.toBeInTheDocument(),
    );
    expect(screen.getByText('Paper')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Item deleted.'));
  });

  it('puts the item back and says so when the server refuses', async () => {
    const user = userEvent.setup();
    server.use(
      http.delete(`${ITEMS}/:id`, () =>
        HttpResponse.json({ title: 'Boom', status: 500 }, { status: 500 }),
      ),
    );
    await seedItems(['Pen']);
    await openItems();
    await user.click(await screen.findByRole('button', { name: 'Delete Pen' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be deleted');
    await waitFor(() => expect(screen.getByText('Pen', { selector: 'p' })).toBeInTheDocument());
  });

  it('stays quiet when the item was already gone (404)', async () => {
    const user = userEvent.setup();
    await seedItems(['Pen']);
    await openItems();
    await user.click(await screen.findByRole('button', { name: 'Delete Pen' }));
    server.use(
      http.delete(`${ITEMS}/:id`, () =>
        HttpResponse.json({ title: 'Not Found', status: 404 }, { status: 404 }),
      ),
    );
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }),
    );
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it('does nothing when the confirmation is cancelled', async () => {
    const user = userEvent.setup();
    await seedItems(['Pen']);
    await openItems();
    await user.click(await screen.findByRole('button', { name: 'Delete Pen' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByText('Pen', { selector: 'p' })).toBeInTheDocument();
  });
});
