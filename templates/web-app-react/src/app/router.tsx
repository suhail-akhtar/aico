import { createRouter, type RouterHistory } from '@tanstack/react-router';
import { routeTree } from '../routeTree.gen';
import { Spinner } from '../shared/ui/Feedback';
import type { RouterContext } from './context';

/** `history` is only passed by tests (an in-memory history); the browser's is the default. */
export function createAppRouter(context: RouterContext, history?: RouterHistory) {
  return createRouter({
    routeTree,
    context,
    history,
    // Load a route's code and data when a link is hovered or focused, so the click feels instant.
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 0,
    scrollRestoration: true,
    // Show a spinner only if navigation takes noticeable time; fast ones do not flash.
    defaultPendingMs: 300,
    defaultPendingComponent: () => (
      <div className="py-16 text-center">
        <Spinner />
      </div>
    ),
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module '@tanstack/react-router' {
  interface Register {
    router: AppRouter;
  }
}
