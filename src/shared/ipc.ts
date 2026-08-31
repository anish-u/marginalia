/**
 * Types shared between the Electron (main/preload) and UI (renderer) processes.
 *
 * Keeping the contract in one place means the preload script and the React
 * app can never drift out of sync. Import from here on both sides.
 */

/** The API surface exposed to the renderer via `contextBridge`. */
export interface MarginaliaApi {
  /** Returns the current app version reported by the main process. */
  getAppVersion: () => Promise<string>;
  /**
   * Asks the main process to open a resource-note window: a browser pane
   * (loading `url`) split alongside a note editor.
   */
  openResourceNoteWindow: (url?: string) => Promise<void>;
  /**
   * Broadcasts a theme change ('light' | 'dark') to every open window. The main
   * process fans it out via `onThemeChanged`, so all windows stay in sync — the
   * cross-window `storage` event is unreliable between separate Electron
   * BrowserWindows, so we route through the main process instead.
   */
  setTheme: (theme: string) => Promise<void>;
  /**
   * Subscribes to theme changes broadcast from any other window. Returns an
   * unsubscribe function; call it on cleanup to remove the listener.
   */
  onThemeChanged: (callback: (theme: string) => void) => () => void;
}
