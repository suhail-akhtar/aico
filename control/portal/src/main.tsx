import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

// Follow the OS colour scheme with the shared tokens' attribute.
const mq = window.matchMedia('(prefers-color-scheme: dark)');
const apply = (): void => document.documentElement.setAttribute('data-theme', mq.matches ? 'dark' : 'light');
apply();
mq.addEventListener('change', apply);

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
