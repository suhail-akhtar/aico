import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { browser } from './shared/browser';
import { expectAccessible, runAxe } from './test/a11y';
import { renderApp, seedItems } from './test/render';

describe('accessibility (axe)', () => {
  it('the landing page', async () => {
    const { container } = await renderApp('/', { signedIn: false });
    await screen.findByRole('heading', { level: 1 });
    await expectAccessible(container);
  });

  it('the sign-in bridge page', async () => {
    vi.spyOn(browser, 'replace').mockImplementation(() => undefined);
    const { container } = await renderApp('/login?returnTo=%2Fitems', { signedIn: false });
    await screen.findByRole('link', { name: 'Continue to sign in' });
    await expectAccessible(container);
  });

  it('an empty items page', async () => {
    const { container } = await renderApp('/items');
    await screen.findByRole('heading', { name: 'No items yet' });
    await expectAccessible(container);
  });

  it('a populated items page', async () => {
    await seedItems(['Pen', 'Paper', 'Stapler']);
    const { container } = await renderApp('/items');
    await screen.findByRole('list', { name: 'Your items' });
    await expectAccessible(container);
  });

  it('the new-item dialog, including its validation errors', async () => {
    const user = userEvent.setup();
    const { container } = await renderApp('/items');
    await user.click(
      (await screen.findAllByRole('button', { name: 'New item' }))[0] as HTMLElement,
    );
    const dialog = await screen.findByRole('dialog', { name: 'New item' });
    await expectAccessible(container);
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await within(dialog).findByText('Enter a name.');
    await expectAccessible(container);
  });

  it('the delete confirmation', async () => {
    const user = userEvent.setup();
    await seedItems(['Pen']);
    const { container } = await renderApp('/items');
    await user.click(await screen.findByRole('button', { name: 'Delete Pen' }));
    await screen.findByRole('dialog', { name: 'Delete this item?' });
    await expectAccessible(container);
  });

  it('the not-found page', async () => {
    const { container } = await renderApp('/nope', { signedIn: false });
    await screen.findByRole('heading', { name: 'Page not found' });
    await expectAccessible(container);
  });

  it('really does catch a violation (the check is not vacuous)', async () => {
    document.body.innerHTML = '<main><img src="x.png"><button></button></main>';
    const { violations } = await runAxe(document.body);
    expect(violations.map((v) => v.id)).toEqual(
      expect.arrayContaining(['image-alt', 'button-name']),
    );
    document.body.innerHTML = '';
  });
});
