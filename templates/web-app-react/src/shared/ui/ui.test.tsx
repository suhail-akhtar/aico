import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { browser } from '../browser';
import { Button, ButtonLink } from './Button';
import { Dialog } from './Dialog';
import { ErrorBoundary } from './ErrorBoundary';
import { EmptyState, ErrorState, ItemsSkeleton, Spinner } from './Feedback';
import { TextArea, TextField } from './TextField';
import { ToastProvider, useToast } from './Toast';

afterEach(() => {
  vi.useRealTimers();
});

describe('Button', () => {
  it('is busy and disabled while loading', () => {
    render(<Button loading>Save</Button>);
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toHaveAttribute('type', 'button');
  });

  it('renders a link that looks like a button', () => {
    render(<ButtonLink href="/x">Go</ButtonLink>);
    expect(screen.getByRole('link', { name: 'Go' })).toHaveAttribute('href', '/x');
  });
});

describe('TextField and TextArea', () => {
  it('ties label, hint and error to the control', () => {
    render(<TextField label="Name" hint="Shown to others" error="Enter a name." />);
    const input = screen.getByLabelText('Name');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    const describedBy = (input.getAttribute('aria-describedby') ?? '').split(' ');
    expect(describedBy).toHaveLength(2);
    expect(document.getElementById(describedBy[0] as string)).toHaveTextContent('Shown to others');
    expect(document.getElementById(describedBy[1] as string)).toHaveTextContent('Enter a name.');
  });

  it('is not marked invalid without an error', () => {
    render(<TextArea label="Notes" />);
    const area = screen.getByLabelText('Notes');
    expect(area).not.toHaveAttribute('aria-invalid');
    expect(area).not.toHaveAttribute('aria-describedby');
  });
});

describe('Dialog', () => {
  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Open
        </button>
        <Dialog open={open} onClose={() => setOpen(false)} title="Hello">
          <button type="button" data-autofocus>
            Inside
          </button>
        </Dialog>
      </>
    );
  }

  it('mounts its content only while open, focuses the marked control, and closes on a backdrop click', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.queryByRole('button', { name: 'Inside' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open' }));
    const dialog = await screen.findByRole('dialog', { name: 'Hello' });
    expect(screen.getByRole('button', { name: 'Inside' })).toHaveFocus();
    await user.click(dialog);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('does not report a close the parent itself caused', async () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <Dialog open onClose={onClose} title="T">
        x
      </Dialog>,
    );
    rerender(
      <Dialog open={false} onClose={onClose} title="T">
        x
      </Dialog>,
    );
    await act(async () => {});
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('Toast', () => {
  function Pusher() {
    const toast = useToast();
    return (
      <>
        <button type="button" onClick={() => toast.push('success', 'Saved.')}>
          ok
        </button>
        <button type="button" onClick={() => toast.push('error', 'Broke.')}>
          bad
        </button>
      </>
    );
  }

  it('announces success politely and errors assertively, and can be dismissed', async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <Pusher />
      </ToastProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'ok' }));
    await user.click(screen.getByRole('button', { name: 'bad' }));
    expect(screen.getByRole('status')).toHaveTextContent('Saved.');
    expect(screen.getByRole('alert')).toHaveTextContent('Broke.');
    await user.click(screen.getAllByRole('button', { name: 'Dismiss' })[0] as HTMLElement);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('removes a toast after its lifetime', () => {
    vi.useFakeTimers();
    render(
      <ToastProvider>
        <Pusher />
      </ToastProvider>,
    );
    act(() => screen.getByRole('button', { name: 'ok' }).click());
    expect(screen.getByRole('status')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(5100));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('keeps only the latest few and refuses use outside the provider', () => {
    function Spam() {
      const toast = useToast();
      return (
        <button
          type="button"
          onClick={() => {
            for (let n = 0; n < 8; n++) toast.push('success', `n${n}`);
          }}
        >
          spam
        </button>
      );
    }
    vi.useFakeTimers();
    render(
      <ToastProvider>
        <Spam />
      </ToastProvider>,
    );
    act(() => screen.getByRole('button', { name: 'spam' }).click());
    expect(screen.getAllByRole('status').length).toBeLessThanOrEqual(4);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<Pusher />)).toThrow('useToast must be used inside');
  });
});

describe('Feedback', () => {
  it('renders a labelled spinner, a skeleton, an empty state and an error state with retry', async () => {
    const retry = vi.fn();
    render(
      <>
        <Spinner label="Working" />
        <ItemsSkeleton />
        <EmptyState title="Nothing" body="Add one." action={<button type="button">Add</button>} />
        <ErrorState title="Failed" body="Because." onRetry={retry} />
      </>,
    );
    expect(screen.getByText('Working')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Nothing' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Failed');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalled();
  });

  it('omits the optional parts', () => {
    render(<ErrorState title="Failed" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('ErrorBoundary', () => {
  function Bomb(): never {
    throw new Error('kaboom');
  }

  it('shows a recoverable screen instead of a blank page', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const reload = vi.spyOn(browser, 'reload').mockImplementation(() => undefined);
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('heading', { name: 'Something went wrong' })).toBeInTheDocument();
    expect(log).toHaveBeenCalled();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Reload' }));
    expect(reload).toHaveBeenCalled();
  });

  it('uses a custom fallback when given one, and renders children when healthy', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { unmount } = render(
      <ErrorBoundary fallback={(error) => <p>custom: {error.message}</p>}>
        <Bomb />
      </ErrorBoundary>,
    );
    expect(screen.getByText('custom: kaboom')).toBeInTheDocument();
    unmount();
    render(
      <ErrorBoundary>
        <p>fine</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText('fine')).toBeInTheDocument();
  });
});
