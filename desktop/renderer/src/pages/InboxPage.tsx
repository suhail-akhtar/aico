/**
 * Waiting for you — the approve-later inbox in the desktop (design §7.7, §8.3).
 *
 * A schedule, a background job or an MCP-submitted run at L4 that reaches a
 * call needing a person parks it instead of running it. This page is where a
 * person reads the exact call and its preview and approves it once or denies
 * it. The card itself is the web client's shared `InboxPanel`; approving goes
 * through main, which attaches a one-time window grant to
 * `/api/inbox/decide` (protocol.ts HUMAN_ROUTES), so the engine can tell the
 * click from the API token. Native notifications for newly parked calls are
 * raised by `notifications.ts`.
 *
 * @module desktop/renderer/pages/InboxPage
 */

import React from 'react';
import { InboxPanel } from '@web/components/InboxPanel';

export function InboxPage(): React.ReactElement {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl px-8 pb-16 pt-10">
        <h1 className="text-[28px] font-semibold tracking-tight">Waiting for you</h1>
        <p className="mt-2 mb-6 text-[14px] text-aico-secondary">
          Steps that unattended runs could not take without you. Each shows the exact call and what it would change;
          approving runs exactly that call, once — and is refused if what it would act on has changed since.
        </p>
        <InboxPanel />
      </div>
    </div>
  );
}
