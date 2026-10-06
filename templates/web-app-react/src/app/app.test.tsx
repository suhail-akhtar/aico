import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { browser } from '../shared/browser';
import { DEV_EMAIL, renderApp } from '../test/render';
import { mockStack, server } from '../test/server';
import { start } from './start';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('routing and the session', () => {
  it('shows the landing page to a visitor, with a sign-in link that comes back to /items', async () => {
    await renderApp('/', { signedIn: false });
    expect(
      await screen.findByRole('heading', { name: 'Keep track of your items', level: 1 }),
    ).toBeInTheDocument();
    const cta = screen.getByRole('link', { name: 'Sign in to continue' });
    expect(cta).toHaveAttribute('href', '/api/auth/start?rd=%2Fitems');
    expect(screen.queryByRole('navigation', { name: 'Main' })).not.toBeInTheDocument();
  });

  it('sends a signed-in user from the landing page to their items', async () => {
    const { router } = await renderApp('/');
    expect(await screen.findByRole('heading', { name: 'Items', level: 1 })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/items');
  });

  it('sends a signed-out visitor from a protected page to /login with the page they wanted', async () => {
    const spy = vi.spyOn(browser, 'replace').mockImplementation(() => undefined);
    const { router } = await renderApp('/items?dialog=new', { signedIn: false });
    expect(router.state.location.pathname).toBe('/login');
    expect(router.state.location.search).toEqual({ returnTo: '/items?dialog=new' });
    const fallback = await screen.findByRole('link', { name: 'Continue to sign in' });
    expect(fallback).toHaveAttribute('href', '/api/auth/start?rd=%2Fitems%3Fdialog%3Dnew');
    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith('/api/auth/start?rd=%2Fitems%3Fdialog%3Dnew'),
    );
  });

  it('will not carry a foreign URL through the sign-in round trip', async () => {
    const spy = vi.spyOn(browser, 'replace').mockImplementation(() => undefined);
    await renderApp('/login?returnTo=https%3A%2F%2Fevil.example%2F', { signedIn: false });
    await waitFor(() => expect(spy).toHaveBeenCalledWith('/api/auth/start?rd=%2F'));
  });

  it('shows who is signed in and a sign-out link to the gateway', async () => {
    await renderApp('/items');
    await screen.findByRole('heading', { name: 'Items', level: 1 });
    const header = screen.getByRole('banner');
    expect(await within(header).findByText(DEV_EMAIL)).toBeInTheDocument();
    expect(within(header).getByRole('link', { name: 'Sign out' })).toHaveAttribute(
      'href',
      '/api/auth/sign_out?rd=/',
    );
    expect(within(header).getByRole('link', { name: 'Items' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('offers sign-in in the header when signed out', async () => {
    await renderApp('/', { signedIn: false });
    await screen.findByRole('heading', { level: 1 });
    expect(
      within(screen.getByRole('banner')).getByRole('link', { name: 'Sign in' }),
    ).toHaveAttribute('href', '/api/auth/start?rd=%2Fitems');
  });

  it('has a skip link that targets the focusable main region', async () => {
    await renderApp('/', { signedIn: false });
    const skip = await screen.findByRole('link', { name: 'Skip to content' });
    expect(skip).toHaveAttribute('href', '#main');
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main');
  });

  it('answers an unknown address with a not-found page and a way home', async () => {
    await renderApp('/nothing/here', { signedIn: false });
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to the start page' })).toHaveAttribute('href', '/');
  });

  it('reports a session that ends mid-use through the API client', async () => {
    const { unauthorized } = await renderApp('/items');
    await screen.findByRole('heading', { name: 'Items', level: 1 });
    mockStack.impersonate(undefined);
    await userEvent
      .setup()
      .click(screen.getAllByRole('button', { name: 'New item' })[0] as HTMLElement);
    const dialog = await screen.findByRole('dialog', { name: 'New item' });
    await userEvent.setup().type(within(dialog).getByLabelText('Name'), 'Late');
    await userEvent.setup().click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(unauthorized()).toBeGreaterThan(0));
  });

  it('shows the route error screen, with a retry, when a page fails to load', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    server.use(
      http.get('*/api/v1/auth/me', () =>
        HttpResponse.json({ title: 'Boom', status: 500 }, { status: 500 }),
      ),
    );
    await renderApp('/items');
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});

describe('theme', () => {
  it('applies and remembers the chosen colour scheme, and clears it for "System"', async () => {
    const user = userEvent.setup();
    await renderApp('/', { signedIn: false });
    const select = await screen.findByRole('combobox', { name: 'Colour scheme' });
    await user.selectOptions(select, 'dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem('theme')).toBe('dark');
    await user.selectOptions(select, 'light');
    expect(document.documentElement.dataset.theme).toBe('light');
    await user.selectOptions(select, 'system');
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(localStorage.getItem('theme')).toBeNull();
  });

  it('starts from the saved choice', async () => {
    localStorage.setItem('theme', 'dark');
    await renderApp('/', { signedIn: false });
    expect(await screen.findByRole('combobox', { name: 'Colour scheme' })).toHaveValue('dark');
  });

  it('still works when storage is blocked', async () => {
    const user = userEvent.setup();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    await renderApp('/', { signedIn: false });
    const select = await screen.findByRole('combobox', { name: 'Colour scheme' });
    expect(select).toHaveValue('system');
    await user.selectOptions(select, 'dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });
});

describe('start-up', () => {
  // jsdom's fetch is Node's, which cannot resolve a relative URL as a browser does. Read
  // `fetch` when the test runs, not at collection: MSW patches it in `beforeAll`.
  function browserLikeFetch() {
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
      realFetch(typeof input === 'string' ? new URL(input, window.location.origin) : input, init),
    );
  }

  it('loads /config.json, then renders the app', async () => {
    browserLikeFetch();
    server.use(http.get('*/config.json', () => HttpResponse.json({ environment: 'test' })));
    mockStack.impersonate(undefined);
    const container = document.body.appendChild(document.createElement('div'));
    const root = await start(container);
    expect(
      await within(container).findByRole('heading', { name: 'Keep track of your items' }),
    ).toBeInTheDocument();
    root.unmount();
    container.remove();
  });

  it('stops on a readable screen when the configuration is invalid', async () => {
    browserLikeFetch();
    server.use(
      http.get('*/config.json', () => HttpResponse.json({ apiBaseUrl: 'https://evil.example' })),
    );
    const container = document.body.appendChild(document.createElement('div'));
    const root = await start(container);
    expect(await within(container).findByRole('alert')).toHaveTextContent('apiBaseUrl');
    expect(
      within(container).getByRole('heading', { name: 'The app is not configured correctly' }),
    ).toBeInTheDocument();
    const reload = vi.spyOn(browser, 'reload').mockImplementation(() => undefined);
    await userEvent.setup().click(within(container).getByRole('button', { name: 'Reload' }));
    expect(reload).toHaveBeenCalled();
    root.unmount();
    container.remove();
  });

  it('sends a user whose session ended to sign-in, remembering where they were', async () => {
    browserLikeFetch();
    vi.spyOn(browser, 'replace').mockImplementation(() => undefined);
    server.use(http.get('*/config.json', () => HttpResponse.json({})));
    mockStack.impersonate(DEV_EMAIL);
    window.history.replaceState(null, '', '/items');
    const container = document.body.appendChild(document.createElement('div'));
    const root = await start(container);
    await within(container).findByRole('heading', { name: 'Items', level: 1 });
    mockStack.impersonate(undefined);
    const user = userEvent.setup();
    await user.click(
      within(container).getAllByRole('button', { name: 'New item' })[0] as HTMLElement,
    );
    const dialog = await screen.findByRole('dialog', { name: 'New item' });
    await user.type(within(dialog).getByLabelText('Name'), 'Late');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(window.location.pathname).toBe('/login'));
    expect(new URLSearchParams(window.location.search).get('returnTo')).toContain('/items');
    root.unmount();
    container.remove();
  });
});
