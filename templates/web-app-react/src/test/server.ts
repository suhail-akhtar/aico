/**
 * The test double for the whole backend: MSW forwards every request to the same
 * mock gateway the dev server uses (`mock/api.ts`). Tests that need a failure
 * the mock cannot produce add a one-off handler with `server.use(...)`.
 */

import { http, passthrough } from 'msw';
import { setupServer } from 'msw/node';
import { createMockStack } from '../../mock/api.ts';

export const mockStack = createMockStack();

export const server = setupServer(
  http.all('*', async ({ request }) => {
    const response = await mockStack.handle(request);
    return response ?? passthrough();
  }),
);
