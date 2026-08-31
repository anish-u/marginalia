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

  /** Renderer → main: prompt for a folder and create/adopt a vault there. */
  VaultCreate = 'vault:create',
  /** Renderer → main: prompt for a folder and open it as the active vault. */
  VaultOpen = 'vault:open',
  /** Renderer → main: get the currently active vault (or null). */
  VaultGetActive = 'vault:get-active',
  /** Main → renderer: pushed to every window when the active vault changes. */
  VaultChanged = 'vault:changed',

  /** Renderer → main: list note summaries in the active vault. */
  NotesList = 'notes:list',
  /** Renderer → main: read a single note by id from the active vault. */
  NoteRead = 'notes:read',
  /** Renderer → main: write (create or overwrite) a note in the active vault. */
  NoteWrite = 'notes:write',
  /** Renderer → main: delete a note by id from the active vault. */
  NoteDelete = 'notes:delete',
  /** Renderer → main: rename a note (change its title) by id. */
  NoteRename = 'notes:rename',
  /** Renderer → main: allocate a unique, title-derived id for a new note. */
  NoteAllocateId = 'notes:allocate-id',
  /** Main → renderer: pushed to every window when the note set changes. */
  NotesChanged = 'notes:changed',
  /** Renderer → main: open a resource-note window for an existing note id. */
  OpenNoteWindow = 'window:open-note',
}
