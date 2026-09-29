/**
 * Calling the browser in main, tolerating a main that does not have a channel.
 *
 * The chrome is written against the full browser contract, and main may be
 * older (or a feature may be switched off). A missing handler is not an error
 * the person should see: the feature is marked unavailable and the control
 * that needs it says so, instead of the whole pane failing.
 *
 * @module desktop/renderer/browser/ipc
 */

import { create } from 'zustand';
import { invoke } from '@/desktop';

/** Channels main has said it does not handle, so the interface can grey their controls. */
export const useMissing = create<{ missing: Record<string, true> }>(() => ({ missing: {} }));

export function isMissingChannel(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err);
  return /No handler registered|Desktop bridge unavailable|not a function|Unknown channel/i.test(msg);
}

function markMissing(channel: string): void {
  if (useMissing.getState().missing[channel]) return;
  useMissing.setState(s => ({ missing: { ...s.missing, [channel]: true } }));
}

/** Invoke; a missing channel resolves `undefined` (and is remembered), any other failure throws. */
export async function call<T>(channel: string, ...args: unknown[]): Promise<T | undefined> {
  try {
    return await invoke<T>(channel, ...args);
  } catch (err) {
    if (isMissingChannel(err)) { markMissing(channel); return undefined; }
    throw err;
  }
}

/** Invoke and swallow every failure — for fire-and-forget controls. */
export function fire(channel: string, ...args: unknown[]): void {
  void call(channel, ...args).catch(() => {});
}

/** With a deadline, for things asked on the way to sending a message. */
export async function callWithin<T>(ms: number, channel: string, ...args: unknown[]): Promise<T | undefined> {
  return Promise.race([
    call<T>(channel, ...args).catch(() => undefined),
    new Promise<undefined>(r => setTimeout(() => r(undefined), ms)),
  ]);
}

/** After a call resolved `undefined`: was that because main has no such channel (rather than returning nothing)? */
export function wasMissing(channel: string): boolean {
  return Boolean(useMissing.getState().missing[channel]);
}

export function useAvailable(channel: string): boolean {
  return useMissing(s => !s.missing[channel]);
}
