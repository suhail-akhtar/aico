import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { setLocale } from '../shared/i18n/i18n';
import { mockStack, server } from './server';

// jsdom has no <dialog> behaviour; this is the part of the spec the components rely on.
const proto = HTMLDialogElement.prototype;
if (typeof proto.showModal !== 'function') {
  proto.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
}
if (typeof proto.close !== 'function') {
  proto.close = function close(this: HTMLDialogElement) {
    if (!this.hasAttribute('open')) return;
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
}

// jsdom does not implement scrolling; the router calls it on navigation.
window.scrollTo = () => undefined;

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));

afterEach(() => {
  cleanup();
  server.resetHandlers();
  mockStack.reset();
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  setLocale('en');
  window.history.replaceState(null, '', '/');
});

afterAll(() => server.close());
