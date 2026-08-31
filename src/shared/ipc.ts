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
  /** Asks the main process to open a new note window. */
  openNoteWindow: () => Promise<void>;
  /**
   * Asks the main process to open a resource-note window: a browser pane
   * (loading `url`) split alongside a note editor.
   */
  openResourceNoteWindow: (url?: string) => Promise<void>;
}
