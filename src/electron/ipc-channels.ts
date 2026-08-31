/**
 * Channel name constants shared between the main process handlers and the
 * preload bridge. Using an enum avoids typos in magic strings across files.
 */
export enum IpcChannels {
  GetAppVersion = 'app:get-version',
  OpenNoteWindow = 'window:open-note',
}
