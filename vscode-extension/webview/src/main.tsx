/**
 * Panel entry point.
 *
 * The transport is configured before React renders, and that ordering is not
 * incidental: `web/src/store.ts` fires its first requests from the effects the
 * initial render schedules, and a store that reached the global `fetch` in a
 * webview would fail every one of them against an origin that does not exist.
 *
 * @module main
 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import { configureTransport } from '@web/transport';
import { installCanvasHost } from '@web/canvas-host';
import { tunnelFetch } from './tunnel';
import { Panel } from './Panel';
import './panel.css';

configureTransport(tunnelFetch);
// Canvas cards expand in place here — the panel is too narrow for a side slot.
installCanvasHost();

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Panel />
  </React.StrictMode>,
);
