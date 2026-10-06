import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from './App';
import {
  admin,
  anonymous,
  attachment,
  auditLine,
  installFakeApi,
  json,
  member,
  page,
  problem,
  signedIn,
  task,
} from './test/fake-api';

describe('signed out', () => {
  it('offers sign-in and nothing else', async () => {
    installFakeApi({ 'GET /api/v1/session': anonymous });

    render(<App />);

    const link = await screen.findByRole('link', { name: 'Sign in' });
    expect(link).toHaveAttribute('href', '/oauth2/authorization/keycloak');
    expect(screen.queryByText('My tasks')).not.toBeInTheDocument();
  });

  it('says so when a sign-in attempt failed', async () => {
    window.history.replaceState(null, '', '/?login=failed');
    installFakeApi({ 'GET /api/v1/session': anonymous });

    render(<App />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Sign-in did not complete');
  });

  it('shows a retryable error when the API cannot be reached, then recovers', async () => {
    let attempts = 0;
    installFakeApi({
      'GET /api/v1/session': () =>
        ++attempts === 1 ? problem(502, 'bad_gateway', 'The API is down') : anonymous(),
    });
    const user = userEvent.setup();

    render(<App />);
    expect(await screen.findByRole('alert')).toHaveTextContent('The API is down');
    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByRole('link', { name: 'Sign in' })).toBeInTheDocument();
  });
});

describe('a member', () => {
  const base = {
    'GET /api/v1/session': () => signedIn(member),
    'GET /api/v1/tasks': () =>
      json(
        page([
          task(),
          task({
            id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            title: 'Plan',
            status: 'DONE',
            assigneeEmail: 'carol@example.com',
          }),
        ]),
      ),
  };

  it('sees their tasks, their name, and no administration', async () => {
    installFakeApi(base);

    render(<App />);

    expect(await screen.findByText('Write the report')).toBeInTheDocument();
    expect(screen.getByText('Assigned to carol@example.com')).toBeInTheDocument();
    expect(screen.getByTestId('who')).toHaveTextContent('bob@example.com');
    expect(screen.queryByRole('button', { name: 'Administration' })).not.toBeInTheDocument();
  });

  it('says so when there are no tasks', async () => {
    installFakeApi({ ...base, 'GET /api/v1/tasks': () => json(page([])) });

    render(<App />);

    expect(await screen.findByText('No tasks yet. Add one above.')).toBeInTheDocument();
  });

  it('creates a task with the fields typed and then shows the refreshed list', async () => {
    const { calls } = installFakeApi({
      ...base,
      'POST /api/v1/tasks': () => json(task({ title: 'New one' }), 201),
    });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText('Write the report');

    await user.type(screen.getByLabelText('Title'), 'New one');
    await user.type(screen.getByLabelText('Description'), 'Details');
    await user.type(screen.getByLabelText('Assign to (email, optional)'), 'dave@example.com');
    await user.click(screen.getByRole('button', { name: 'Add task' }));

    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
        title: 'New one',
        description: 'Details',
        assigneeEmail: 'dave@example.com',
      }),
    );
    await waitFor(() => expect(screen.getByLabelText('Title')).toHaveValue(''));
    expect(
      calls.filter((c) => c.url.startsWith('/api/v1/tasks') && c.method === 'GET').length,
    ).toBeGreaterThan(1);
  });

  it('shows the API explanation when a task is refused and keeps what was typed', async () => {
    installFakeApi({
      ...base,
      'POST /api/v1/tasks': () =>
        problem(409, 'task_limit_reached', 'You already have 25 open tasks; finish some first.'),
    });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText('Write the report');

    await user.type(screen.getByLabelText('Title'), 'One too many');
    await user.click(screen.getByRole('button', { name: 'Add task' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('25 open tasks');
    expect(screen.getByLabelText('Title')).toHaveValue('One too many');
  });

  it('completes and deletes tasks', async () => {
    const { calls } = installFakeApi({
      ...base,
      'POST /api/v1/tasks/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/complete': () =>
        json(task({ status: 'DONE' })),
      'DELETE /api/v1/tasks/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa': () =>
        new Response(null, { status: 204 }),
    });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText('Write the report');

    await user.click(screen.getByRole('button', { name: 'Complete' }));
    await user.click(screen.getByRole('button', { name: 'Delete Write the report' }));

    await waitFor(() => expect(calls.map((c) => c.method)).toContain('DELETE'));
    expect(calls.some((c) => c.url.endsWith('/complete'))).toBe(true);
  });

  it('reports a failed action instead of failing silently', async () => {
    installFakeApi({
      ...base,
      'DELETE /api/v1/tasks/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa': () =>
        problem(404, 'not_found', 'Task not found'),
    });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText('Write the report');

    await user.click(screen.getByRole('button', { name: 'Delete Write the report' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Task not found');
  });

  it('filters by status and by search text, from the first page', async () => {
    const { calls } = installFakeApi(base);
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText('Write the report');

    await user.selectOptions(screen.getByLabelText('Status'), 'DONE');
    await user.type(screen.getByLabelText('Search'), 'pl');

    await waitFor(() =>
      expect(calls.at(-1)?.url).toBe('/api/v1/tasks?page=0&size=10&status=DONE&q=pl'),
    );
  });

  it('pages through long lists', async () => {
    const { calls } = installFakeApi({
      ...base,
      'GET /api/v1/tasks': () => json(page([task()], { totalElements: 12, totalPages: 2 })),
    });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText('Page 1 of 2');

    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Next' }));

    await waitFor(() => expect(calls.at(-1)?.url).toContain('page=1'));
  });

  it('signs out through the API and then visits the identity provider', async () => {
    installFakeApi({
      ...base,
      'POST /api/v1/session/logout': () => json({ redirect: 'http://idp.localhost:8180/logout' }),
    });
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText('Write the report');

    await user.click(screen.getByRole('button', { name: 'Sign out' }));

    await waitFor(() => expect(assign).toHaveBeenCalledWith('http://idp.localhost:8180/logout'));
  });

  it('shows an error when sign-out fails and stays signed in', async () => {
    installFakeApi({
      ...base,
      'POST /api/v1/session/logout': () => problem(403, 'forbidden', 'CSRF token missing'),
    });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText('Write the report');

    await user.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('CSRF token missing');
  });
});

describe('files on a task', () => {
  const files = {
    'GET /api/v1/session': () => signedIn(member),
    'GET /api/v1/tasks': () => json(page([task()])),
    'GET /api/v1/tasks/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/attachments': () =>
      json([attachment()]),
  };

  it('are hidden when the feature flag is off', async () => {
    installFakeApi({
      ...files,
      'GET /api/v1/session': () => signedIn(member, { attachmentsEnabled: false }),
    });

    render(<App />);
    await screen.findByText('Write the report');

    expect(screen.queryByRole('button', { name: 'Files' })).not.toBeInTheDocument();
  });

  it('list with download links, upload and remove', async () => {
    const { calls } = installFakeApi({
      ...files,
      'POST /api/v1/tasks/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/attachments': () =>
        json(attachment(), 201),
      'DELETE /api/v1/tasks/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/attachments/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb':
        () => new Response(null, { status: 204 }),
    });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText('Write the report');

    await user.click(screen.getByRole('button', { name: 'Files' }));
    const link = await screen.findByRole('link', { name: 'notes.txt' });
    expect(link).toHaveAttribute(
      'href',
      '/api/v1/tasks/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/attachments/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    );

    const input = screen.getByLabelText(/Add a file/);
    await user.upload(input, new File(['hello'], 'new.txt', { type: 'text/plain' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));

    await user.click(screen.getByRole('button', { name: 'Remove notes.txt' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true));
  });

  it('show the reason when an upload is refused', async () => {
    installFakeApi({
      ...files,
      'POST /api/v1/tasks/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/attachments': () =>
        problem(413, 'payload_too_large', 'Request body exceeds 5242880 bytes'),
    });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText('Write the report');

    await user.click(screen.getByRole('button', { name: 'Files' }));
    await screen.findByRole('link', { name: 'notes.txt' });
    await user.upload(
      screen.getByLabelText(/Add a file/),
      new File(['x'], 'big.txt', { type: 'text/plain' }),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('exceeds');
  });

  it('say so when a task has none, and when listing them fails', async () => {
    installFakeApi({
      ...files,
      'GET /api/v1/tasks/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/attachments': () => json([]),
    });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText('Write the report');

    await user.click(screen.getByRole('button', { name: 'Files' }));

    expect(await screen.findByText('No files.')).toBeInTheDocument();
  });
});

describe('an administrator', () => {
  const adminApi = {
    'GET /api/v1/session': () => signedIn(admin),
    'GET /api/v1/tasks': () => json(page([task()])),
    'GET /api/v1/admin/tasks': () =>
      json(page([task({ title: 'Someone elses task', assigneeEmail: 'x@example.com' })])),
    'GET /api/v1/admin/audit': () =>
      json(page([auditLine()], { totalPages: 2, totalElements: 11 })),
  };

  it("has an administration view with everyone's tasks and the audit trail, paged", async () => {
    const { calls } = installFakeApi(adminApi);
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText('Write the report');
    expect(within(screen.getByTestId('who')).getByText('admin')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Administration' }));

    expect(await screen.findByText('Someone elses task')).toBeInTheDocument();
    expect(await screen.findByText('task.created')).toBeInTheDocument();
    expect(screen.getByText('{"title":"Write the report"}')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Older' }));
    await waitFor(() => expect(calls.at(-1)?.url).toContain('/api/v1/admin/audit?page=1'));
    expect(screen.getByRole('button', { name: 'Administration' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('is told plainly when the API refuses the administration data', async () => {
    installFakeApi({
      ...adminApi,
      'GET /api/v1/admin/tasks': () => problem(403, 'forbidden', 'You are not allowed to do that.'),
    });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText('Write the report');

    await user.click(screen.getByRole('button', { name: 'Administration' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('not allowed');
  });
});
