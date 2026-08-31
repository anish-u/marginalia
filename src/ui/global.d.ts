import type { MarginaliaApi } from '@shared/ipc';

/**
 * Minimal typing for the subset of Electron's `<webview>` element API we use.
 *
 * Electron ships full `<webview>` types, but they aren't in the renderer's
 * default DOM lib, so we declare only what `ResourceNoteView` touches:
 *   - `executeJavaScript` to read the guest page's current text selection
 *   - `getURL` to record where a clipped highlight came from
 *   - navigation: `goBack`/`goForward`/`reload`/`stop`/`loadURL` and the
 *     `canGoBack`/`canGoForward` predicates that drive the nav toolbar
 */
export interface WebviewElement extends HTMLElement {
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
  getURL(): string;
  goBack(): void;
  goForward(): void;
  reload(): void;
  stop(): void;
  loadURL(url: string): Promise<void>;
  canGoBack(): boolean;
  canGoForward(): boolean;
}

/**
 * Augments the renderer's `window` with the API injected by the preload
 * script through `contextBridge.exposeInMainWorld`.
 */
declare global {
  interface Window {
    marginalia: MarginaliaApi;
  }
}

export {};
