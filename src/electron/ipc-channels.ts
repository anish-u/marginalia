/**
 * Channel name constants shared between the main process handlers and the
 * preload bridge. Using an enum avoids typos in magic strings across files.
 */
export enum IpcChannels {
  GetAppVersion = 'app:get-version',
  OpenResourceNoteWindow = 'window:open-resource-note',
  /** Renderer → main: a window asks to broadcast a theme change. */
  SetTheme = 'theme:set',
  /** Main → renderer: pushed to every window when the theme changes. */
  ThemeChanged = 'theme:changed',
}
