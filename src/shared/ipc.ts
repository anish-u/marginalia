/**
 * Types shared between the Electron (main/preload) and UI (renderer) processes.
 *
 * Keeping the contract in one place means the preload script and the React
 * app can never drift out of sync. Import from here on both sides.
 */

import type {
  Result,
  VaultInfo,
  ResourceNote,
  ResourceNoteInput,
  ResourceNoteSummary,
} from '@shared/resource-note';

/** The API surface exposed to the renderer via `contextBridge`. */
export interface MarginaliaApi {
  /** Returns the current app version reported by the main process. */
  getAppVersion: () => Promise<string>;
  /**
   * Asks the main process to open a resource-note window: a browser pane
   * (loading `url`) split alongside a note editor. An optional `title` seeds the
   * note's title field so a note created from the launcher starts with the name
   * the user chose.
   */
  openResourceNoteWindow: (url?: string, title?: string) => Promise<void>;
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

  // --- Vault + notes persistence (see @shared/resource-note for the vocabulary) ---

  /**
   * Prompts for a folder and designates it a vault, setting it active (Req 1).
   * Resolves to `null` when the user cancels the picker (Req 1.6); errors are
   * returned as data (e.g. `marker-create-failed`) rather than thrown.
   */
  createVault: () => Promise<Result<VaultInfo | null>>;
  /**
   * Prompts for an existing vault folder and opens it, replacing any prior
   * active vault (Req 2). Resolves to `null` when the user cancels (Req 2.5);
   * `not-a-vault` / `vault-unreadable` are returned as data, leaving the active
   * vault unchanged.
   */
  openVault: () => Promise<Result<VaultInfo | null>>;
  /** Returns the current active vault, or `null` if none (boot + display, Req 2.6). */
  getActiveVault: () => Promise<VaultInfo | null>;
  /**
   * Subscribes to active-vault changes broadcast from the main process. Mirrors
   * `onThemeChanged`: the callback fires with the new vault (or `null` when
   * cleared), and the returned function unsubscribes — call it on cleanup
   * (Req 3.3).
   */
  onVaultChanged: (callback: (vault: VaultInfo | null) => void) => () => void;

  /**
   * Lists note summaries in the active vault, most-recently-modified first
   * (Req 3.1, 6.1). A partly-corrupt vault still succeeds, surfacing skipped
   * files via the additive `diagnostics` field on the success result (Req 6.7).
   */
  listNotes: () => Promise<Result<ResourceNoteSummary[]>>;
  /** Reads one full note by id (Req 6.3). */
  readNote: (id: string) => Promise<Result<ResourceNote>>;
  /**
   * Writes (creates or overwrites in place) a note (Req 5). Timestamps are set
   * by the store, not the caller; resolves with the persisted note carrying its
   * updated `createdAt`/`modifiedAt`.
   */
  writeNote: (note: ResourceNoteInput) => Promise<Result<ResourceNote>>;
  /**
   * Deletes a note by id from the active vault. Resolves with
   * `{ ok: true }` on success, or `note-not-found` (already gone) /
   * `delete-failed` / `no-vault` as data.
   */
  deleteNote: (id: string) => Promise<Result<void>>;
  /**
   * Renames a note — sets its title AND moves the on-disk file so the filename
   * tracks the new title (`<new-slug>.md`). The note's id therefore changes to
   * the new slug; `createdAt` is preserved and `modifiedAt` bumped. Slug
   * collisions get a numeric suffix, and an unchanged slug degrades to an
   * in-place rewrite. Resolves with the persisted note (carrying its **new**
   * id), or a `note-not-found` / `no-vault` / write error as data. A blank
   * title falls back to the default. The rest of the note (resource, prose,
   * highlights) is unchanged.
   */
  renameNote: (id: string, title: string) => Promise<Result<ResourceNote>>;
  /**
   * Allocates a unique, filesystem-safe id derived from a note title, for use
   * when a note is first saved so its on-disk filename matches the title (e.g.
   * `my-research-notes.md`). Falls back to a default-derived slug for a blank
   * title, and appends a numeric suffix if the slug is already taken. Resolves
   * to `null` when there is no active vault.
   */
  allocateNoteId: (title: string) => Promise<string | null>;
  /** Asks the main process to open a note in a resource-note window (Req 3.6). */
  openNoteWindow: (id: string) => Promise<Result<void>>;
  /**
   * Subscribes to note-set changes broadcast from the main process (a note was
   * written, deleted, or renamed in any window). Mirrors `onVaultChanged`: the
   * callback fires when the active vault's notes may have changed, and the
   * returned function unsubscribes — call it on cleanup. Lets an open list
   * refresh live when a note is mutated from another window.
   *
   * The callback receives `{ oldId, newId }` when the change was a rename that
   * moved a note's file to a new id (so an open note-editor window bound to
   * `oldId` can adopt `newId`), or `null` for any other change.
   */
  onNotesChanged: (
    callback: (rename: NotesChangedInfo | null) => void,
  ) => () => void;
}

/**
 * Payload for {@link MarginaliaApi.onNotesChanged} describing *which* note
 * changed, so an open note window can react precisely (reload its content when
 * the same note was edited in another window, or adopt a new id after a rename)
 * rather than just refreshing a list.
 *
 * - `id` — the note that was written, deleted, or renamed. For a rename it is
 *   the note's *new* id (post-move). Absent for a change that isn't tied to a
 *   single note (e.g. an external filesystem event picked up by the watcher).
 * - `oldId`/`newId` — present only for a rename that moved a note's file, so a
 *   window bound to `oldId` can adopt `newId`.
 */
export interface NotesChangedInfo {
  id?: string;
  oldId?: string;
  newId?: string;
}
