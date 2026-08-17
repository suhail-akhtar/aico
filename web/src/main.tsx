import React from 'react';
import { createRoot } from 'react-dom/client';
import '@aico/ui/theme.css';
import './styles.css';
import { App } from './App';
import { bootstrapToken } from './api';

// Claim the token from the launch URL before anything renders, so no component
// ever has to think about whether it is authenticated yet.
bootstrapToken();

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
