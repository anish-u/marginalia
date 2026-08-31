import { BrowserWindow, ipcMain } from 'electron';

import { IpcChannels } from '@main/ipc-channels';
import { vaultManager } from '@main/ipc/vault';
import { NoteStore } from '@main/vault/note-store';
import {
  markAppWrite,
  setNotesChangeHandler,
  watchNotesDir,
} from '@main/vault/notes-watcher';
import { createResourceNoteWindow } from '@main/windows';

import type { NotesChangedInfo } from '@shared/ipc';
import type {
  ResourceNote,
  ResourceNoteInput,
  ResourceNoteSummary,
  Result,
} from '@shared/resource-note';

/**
 * Fan a `NotesChanged` broadcast out to every open window.
 *
 * Mirrors the `VaultChanged` fan-out in `ipc/vault.ts`: a note written,
 * deleted, or renamed in one window (e.g. a note window autosaving, or the
 * launcher deleting a row) must let every *other* window's notes list refresh.
 * We send to all windows including the sender — an open list re-fetches and the
 * cost of an extra fetch is trivial, so there's no need to exclude the sender.
 *
 * The optional `info` payload names the affected note: `id` is the note that
 * was written/deleted/renamed (so an open window showing that note can reload
 * its content), and `oldId`/`newId` are set for a rename that moved the file
 * (so a window bound to `oldId` adopts `newId`). A bare change (e.g. an external
 * filesystem event from the watcher) sends `null` — every list just re-fetches.
 *
 * Exported so the on-disk notes watcher (see `notes-watcher.ts`) can trigger the
 * same refresh when files change *outside* the app (e.g. deleted in Finder).
 */
export function broadcastNotesChanged(info?: NotesChangedInfo): void {
  const wins = BrowserWindow.getAllWindows();
  for (const win of wins) {
    win.webContents.send(IpcChannels.NotesChanged, info ?? null);
  }
}

/**
 * Point the on-disk notes watcher at a vault (or `null` to stop). Called on
 * boot and on every active-vault change so external file changes in the current
 * vault refresh the list. A no-op re-point (same dir) is cheap and idempotent.
 */
export function watchActiveVaultNotes(vaultPath: string | null): void {
  watchNotesDir(vaultPath);
}

/**
 * Process-wide {@link NoteStore} backed by the real filesystem.
 *
 * The store is stateless aside from its fs seam — every method takes the vault
 * path explicitly — so a single shared instance serves whichever vault is
 * currently active. The active vault path is resolved per-call from the shared
 * {@link vaultManager} (imported from `ipc/vault`, never re-constructed, so all
 * of the main process agrees on which vault is active).
 */
const noteStore = new NoteStore();

/**
 * Registers IPC handlers for note persistence (`notes:*`) and opening an
 * existing note in its own window (`window:open-note`), delegating file work to
 * the shared {@link noteStore} against the active vault from {@link vaultManager}.
 *
 * The active vault is app-global state; each handler reads it fresh via
 * `vaultManager.getActive()` so a create/open/restore that happened in any
 * window is immediately reflected here. Errors are returned as data
 * (`Result`), never thrown across the IPC boundary, matching the rest of the
 * vault/notes surface.
 *
 * No-vault handling differs by operation, by design:
 * - **List** is non-erroring: with no active vault there simply are no notes,
 *   so we return an empty list (`{ ok: true, value: [] }`). The launcher shows
 *   its empty/no-vault state from `getActiveVault()`, not from a list error
 *   (Req 3.1, 6.1).
 * - **Read** with no active vault has no note to find, so it returns
 *   `note-not-found` for the requested id (the closest existing code; the
 *   union has no dedicated "no vault to read from" code, and Req 6.4 already
 *   models "there is no such note" as `note-not-found`). The vault is left
 *   untouched — consistent with an absent-file read.
 * - **Write** with no active vault returns `no-vault` and creates no file
 *   (Req 5.6): saving is meaningless without a destination, and we must not
 *   silently drop the user's content or invent a vault.
 */
export const registerNotesHandlers = (): void => {
  // Wire the on-disk watcher to the broadcast, then point it at whatever vault
  // is active now (restore() has already run on boot). Subsequent vault changes
  // re-point it via `watchActiveVaultNotes` (called from ipc/vault.ts).
  setNotesChangeHandler(broadcastNotesChanged);
  watchNotesDir(vaultManager.getActive()?.path ?? null);

  ipcMain.handle(
    IpcChannels.NotesList,
    async (): Promise<Result<ResourceNoteSummary[]>> => {
      const active = vaultManager.getActive();
      // No active vault ⇒ no notes to list. This is an empty result, not an
      // error: the launcher decides what to render from getActiveVault(), and
      // the list view for a vault-less app is simply empty (Req 3.1, 6.1).
      if (active === null) {
        return { ok: true, value: [] };
      }
      return noteStore.list(active.path);
    },
  );

  ipcMain.handle(
    IpcChannels.NoteRead,
    async (_event, id: string): Promise<Result<ResourceNote>> => {
      const active = vaultManager.getActive();
      // No active vault ⇒ there is no note at that id to read. Report it as
      // note-not-found (Req 6.4) — the same non-destructive "no such note"
      // outcome as reading a missing file inside a real vault.
      if (active === null) {
        return {
          ok: false,
          error: {
            code: 'note-not-found',
            message: `Note '${id}' was not found: no active vault`,
            noteId: id,
          },
        };
      }
      return noteStore.read(active.path, id);
    },
  );

  ipcMain.handle(
    IpcChannels.NoteWrite,
    async (
      _event,
      note: ResourceNoteInput,
    ): Promise<Result<ResourceNote>> => {
      const active = vaultManager.getActive();
      // No active vault ⇒ nowhere to save. Return no-vault and create no file
      // (Req 5.6); the caller keeps the in-memory note and can prompt the user
      // to create/open a vault.
      if (active === null) {
        return {
          ok: false,
          error: {
            code: 'no-vault',
            message: 'Cannot save the note: no active vault.',
          },
        };
      }
      // Open the watcher's quiet window *before* touching disk so the fs.watch
      // events this write produces are recognised as our own and suppressed —
      // the explicit broadcast below is the single notification for this action
      // (Req 3.1, 3.2).
      markAppWrite();
      const result = await noteStore.write(active.path, note);
      // A successful write may have created a new note or changed its title —
      // let every window's list refresh (Req 3.1/3.3-style consistency) and
      // name the note so another window showing it can reload its content.
      if (result.ok) broadcastNotesChanged({ id: result.value.id });
      return result;
    },
  );

  ipcMain.handle(
    IpcChannels.NoteDelete,
    async (_event, id: string): Promise<Result<void>> => {
      const active = vaultManager.getActive();
      // No active vault ⇒ the note cannot exist. Report note-not-found (mirrors
      // read), leaving nothing to delete.
      if (active === null) {
        return {
          ok: false,
          error: {
            code: 'note-not-found',
            message: `Note '${id}' was not found: no active vault`,
            noteId: id,
          },
        };
      }
      // Suppress the watcher echo for our own delete; the broadcast below is
      // the single notification for this action (Req 3.1, 3.2).
      markAppWrite();
      const result = await noteStore.delete(active.path, id);
      if (result.ok) broadcastNotesChanged({ id });
      return result;
    },
  );

  ipcMain.handle(
    IpcChannels.NoteRename,
    async (_event, id: string, title: string): Promise<Result<ResourceNote>> => {
      const active = vaultManager.getActive();
      // No active vault ⇒ nothing to rename.
      if (active === null) {
        return {
          ok: false,
          error: {
            code: 'no-vault',
            message: 'Cannot rename the note: no active vault.',
          },
        };
      }

      // Rename moves the note's file so the filename matches the new title
      // (`<new-slug>.md`), preserving createdAt and the note's resource/content.
      // The store handles slug collisions and does an in-place rewrite when the
      // slug is unchanged. Any read error (note-not-found / unreadable /
      // unknown-type) is returned verbatim, leaving the file untouched.
      //
      // A rename touches the notes dir (either an in-place rewrite or a
      // delete+create for the move), so open the quiet window first to suppress
      // the watcher echo; the broadcast below is the single notification for
      // this action (Req 3.1, 3.2).
      markAppWrite();
      const result = await noteStore.rename(active.path, id, title);
      if (result.ok) {
        // Always name the (new) id so a window showing it can reload. When the
        // id actually moved, also include {oldId, newId} so a window bound to
        // the old id adopts the new one instead of recreating the old file on
        // its next autosave.
        broadcastNotesChanged(
          result.value.id !== id
            ? { id: result.value.id, oldId: id, newId: result.value.id }
            : { id: result.value.id },
        );
      }
      return result;
    },
  );

  ipcMain.handle(
    IpcChannels.NoteAllocateId,
    async (_event, title: string): Promise<string | null> => {
      const active = vaultManager.getActive();
      // No vault ⇒ no place to allocate against; the renderer keeps its note in
      // memory until a vault exists.
      if (active === null) return null;
      return noteStore.allocateId(active.path, title);
    },
  );

  ipcMain.handle(
    IpcChannels.OpenNoteWindow,
    async (_event, id: string): Promise<Result<void>> => {
      const active = vaultManager.getActive();
      // No active vault ⇒ the note cannot exist. Mirror NoteRead's handling so
      // the launcher surfaces the same non-destructive not-found error (Req 3.8).
      if (active === null) {
        return {
          ok: false,
          error: {
            code: 'note-not-found',
            message: `Note '${id}' was not found: no active vault`,
            noteId: id,
          },
        };
      }

      // Verify the note actually exists (and is readable) before spawning a
      // window (Req 3.8). read() returns the note's Result verbatim, so a
      // missing id surfaces as note-not-found and an unparseable/unknown-type
      // file surfaces its own error — all returned to the renderer as data,
      // leaving the list unchanged.
      const existing = await noteStore.read(active.path, id);
      if (!existing.ok) {
        return { ok: false, error: existing.error };
      }

      // The note exists: open a resource-note window bound to it. Window
      // creation stays in the main process; the renderer only sent intent.
      //
      // Coordination with task 10.1: that task extends createResourceNoteWindow
      // to accept an optional `noteId` (appended as `?noteId=<id>` to the route
      // hash) so the renderer can load the existing note. We call it with the
      // id in that trailing position now; the cast keeps this forward-compatible
      // with 10.1's landed signature regardless of which task merges first.
      (
        createResourceNoteWindow as (
          url?: string,
          noteId?: string,
        ) => unknown
      )(undefined, id);

      return { ok: true, value: undefined };
    },
  );
};
