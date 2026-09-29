import React from 'react';
import { createRoot } from 'react-dom/client';
import '@aico/ui/theme.css';
import './styles.css';
import { App } from './App';
import { setMediaUrlResolver } from '@aico/ui';
import { bootstrapToken, getToken } from './api';
import { installCanvasHost } from './canvas-host';

// Claim the token from the launch URL before anything renders, so no component
// ever has to think about whether it is authenticated yet.
bootstrapToken();

// Engine-served images (`/api/attachments/file?…`, from ```images blocks) are
// loaded by <img>, which cannot send the token header — so it rides as a query
// parameter, added at display time only and never written into a block.
setMediaUrlResolver(url => `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(getToken())}`);

// Canvas cards and editors reach the engine through the store and the API.
// No side slot here, so "Open" expands a canvas in place.
installCanvasHost();

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
