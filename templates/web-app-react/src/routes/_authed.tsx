import { createFileRoute, Outlet, redirect } from '@tanstack/react-router';
import { sessionQuery } from '../auth/auth';

/**
 * Pathless layout: everything under `_authed/` needs a session. The check is
 * UX, not security: the API enforces authorization on every call. A signed-out
 * visitor is sent through `/login`, which carries the page they wanted.
 */
export const Route = createFileRoute('/_authed')({
  beforeLoad: async ({ context, location }) => {
    const user = await context.queryClient.ensureQueryData(sessionQuery);
    if (!user) {
      throw redirect({ to: '/login', search: { returnTo: location.href } });
    }
    return { user };
  },
  component: Outlet,
});
