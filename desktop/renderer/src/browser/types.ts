/**
 * The built-in browser's IPC contract, as the chrome names it.
 *
 * The shapes themselves live in `desktop/shared/browser-types.ts`, which main
 * produces against; this file re-exports them under the names the chrome
 * uses, and adds the two older shapes it still accepts (the pre-contract tab
 * list and the hand-over event).
 *
 * @module desktop/renderer/browser/types
 */

import type {
  AuthRequest, ConfirmRequest, DialogRequest, PageInsights, PageRead, PermissionRequest, PermissionSetting,
  SecurityState, TabState,
} from '@desk/browser-types';

export type {
  AgentEvent, Bookmark, BrowserState, DownloadItem, DownloadState, FindResult, FormModel, HistoryEntry, SiteInfo, TabState,
} from '@desk/browser-types';

export type Security = SecurityState;
export type PermissionValue = PermissionSetting;
export type ReadResult = PageRead;
export type Insights = PageInsights;
export type PermissionPrompt = PermissionRequest;
export type DialogPrompt = DialogRequest;
export type AuthPrompt = AuthRequest;
export type ConfirmPrompt = ConfirmRequest;
export type TabError = NonNullable<TabState['error']>;

/** The agent's hand-over (`browser:handoff`): it needs the person to do something it must not. */
export interface HandoffPrompt { id: string; message: string }

/** The pre-contract tab shape (`browser:tabs`), still accepted as a fallback. */
export interface LegacyTab {
  id: string; url: string; title: string; favicon?: string; loading: boolean;
  canGoBack: boolean; canGoForward: boolean; active: boolean; zoom: number;
}
