import { useCallback, useEffect, useState } from 'react';
import { api, type Session, SIGN_IN_URL } from './api';
import { Admin } from './components/Admin';
import { errorMessage } from './components/errors';
import { Tasks } from './components/Tasks';

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; session: Session };

type View = 'tasks' | 'admin';

/**
 * The shell: ask the API who is calling, then show either the sign-in page or the signed-in app.
 * "Not signed in" is an answer to that question (authenticated=false), not an error.
 */
export function App() {
  const [state, setState] = useState<State>({ status: 'loading' });

  const load = useCallback(() => {
    setState({ status: 'loading' });
    api
      .session()
      .then((session) => setState({ status: 'ready', session }))
      .catch((error: unknown) => setState({ status: 'error', message: errorMessage(error) }));
  }, []);

  useEffect(load, [load]);

  if (state.status === 'loading') {
    return (
      <main className="center" aria-busy="true">
        <p>Loading...</p>
      </main>
    );
  }
  if (state.status === 'error') {
    return (
      <main className="center">
        <h1>System</h1>
        <p role="alert" className="error">
          {state.message}
        </p>
        <button type="button" onClick={load}>
          Try again
        </button>
      </main>
    );
  }
  const { session } = state;
  if (!session.authenticated || !session.user) return <SignIn />;
  return <Shell session={session} />;
}

function SignIn() {
  const failed = new URLSearchParams(window.location.search).get('login') === 'failed';
  return (
    <main className="center">
      <h1>System</h1>
      <p>Sign in with your organisation account to manage your tasks.</p>
      {failed && (
        <p role="alert" className="error">
          Sign-in did not complete. Please try again.
        </p>
      )}
      <a className="button primary" href={SIGN_IN_URL}>
        Sign in
      </a>
    </main>
  );
}

function Shell({ session }: { session: Session }) {
  const [view, setView] = useState<View>('tasks');
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const user = session.user;
  if (!user) return null;
  const isAdmin = user.roles.includes('ADMIN');

  async function signOut() {
    try {
      window.location.assign(await api.logout());
    } catch (error) {
      setSignOutError(errorMessage(error));
    }
  }

  return (
    <>
      <header className="bar">
        <strong>System</strong>
        <nav aria-label="Main">
          <button
            type="button"
            aria-current={view === 'tasks' ? 'page' : undefined}
            onClick={() => setView('tasks')}
          >
            My tasks
          </button>
          {isAdmin && (
            <button
              type="button"
              aria-current={view === 'admin' ? 'page' : undefined}
              onClick={() => setView('admin')}
            >
              Administration
            </button>
          )}
        </nav>
        <span className="who" data-testid="who">
          {user.email ?? user.name}
          {isAdmin && <span className="badge">admin</span>}
        </span>
        <button type="button" onClick={signOut}>
          Sign out
        </button>
      </header>
      {signOutError && (
        <p role="alert" className="error">
          {signOutError}
        </p>
      )}
      <main>
        {view === 'tasks' || !isAdmin ? (
          <Tasks attachmentsEnabled={session.features?.attachmentsEnabled ?? false} />
        ) : (
          <Admin />
        )}
      </main>
    </>
  );
}
