import { useCallback, useEffect, useState, type FC } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type {
  ResourceNoteSummary,
  VaultInfo,
} from '@shared/resource-note';

import { DEFAULT_TITLE_PLACEHOLDER, NoteListItem } from './NoteListItem';

/**
 * The notes list shown when a vault is active (Req 3.1).
 *
 * Fetches summaries from the active vault via `listNotes()` and renders one
 * {@link NoteListItem} per note. The store already returns them
 * most-recently-modified first (Req 3.1, 6.1), so we render them in the order
 * received and never re-sort here.
 *
 * This component assumes a vault is active — the host (MainView) decides
 * between the empty state and this view based on `getActiveVault()` +
 * `onVaultChanged`. It re-fetches when the `vault` prop identity changes (a
 * vault switch) and also subscribes to `onNotesChanged`, so a note created,
 * renamed, or deleted in *any* window refreshes the list live.
 *
 * Per-row actions:
 * - **Open** — opens the note in its own resource-note window (Req 3.6/3.8).
 * - **Rename** — inline title edit; persisted via `renameNote` then refreshed.
 * - **Delete** — asks for confirmation (destructive), then `deleteNote` +
 *   refresh. Failures surface inline and leave the list unchanged.
 */
export const NotesListView: FC<{
  /**
   * The active vault. Its identity is used as the re-fetch trigger: pass a new
   * object when the active vault changes to force a refresh. `null` renders
   * nothing meaningful (the host should show the empty state instead).
   */
  vault: VaultInfo | null;
}> = ({ vault }) => {
  const [notes, setNotes] = useState<ResourceNoteSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // The note pending delete-confirmation, or null when no dialog is shown.
  const [pendingDelete, setPendingDelete] = useState<ResourceNoteSummary | null>(
    null,
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    setListError(null);
    // Clear any prior action-failure message on a fresh fetch; a vault switch
    // clears selection/errors (Req 3.3).
    setActionError(null);
    try {
      const result = await window.marginalia.listNotes();
      if (!result.ok) {
        setListError(result.error.message);
        return;
      }
      setNotes(result.value);
    } catch {
      setListError('Could not load notes from this vault.');
    } finally {
      setLoading(false);
    }
  }, []);

  // Re-fetch on mount and whenever the active vault changes (prop identity).
  useEffect(() => {
    void refresh();
  }, [vault, refresh]);

  // Refresh live when a note is written/renamed/deleted in any window.
  useEffect(
    () => window.marginalia.onNotesChanged(() => void refresh()),
    [refresh],
  );

  const openNote = async (id: string) => {
    setActionError(null);
    try {
      const result = await window.marginalia.openNoteWindow(id);
      if (!result.ok) {
        // Leave entries unchanged, surface an inline error (Req 3.8).
        setActionError(result.error.message);
      }
    } catch {
      setActionError('Could not open that note.');
    }
  };

  const renameNote = async (id: string, title: string) => {
    setActionError(null);
    try {
      const result = await window.marginalia.renameNote(id, title);
      if (!result.ok) {
        setActionError(result.error.message);
        return;
      }
      // The main process broadcasts NotesChanged, but refresh here too so the
      // rename is reflected immediately even if the broadcast is delayed.
      await refresh();
    } catch {
      setActionError('Could not rename that note.');
    }
  };

  const confirmDelete = async () => {
    const target = pendingDelete;
    if (!target) return;
    setPendingDelete(null);
    setActionError(null);
    try {
      const result = await window.marginalia.deleteNote(target.id);
      if (!result.ok) {
        setActionError(result.error.message);
        return;
      }
      await refresh();
    } catch {
      setActionError('Could not delete that note.');
    }
  };

  const deleteLabel = pendingDelete
    ? pendingDelete.title.trim() || DEFAULT_TITLE_PLACEHOLDER
    : '';

  return (
    <div className="flex w-full max-w-4xl flex-col gap-3 px-5">
      {actionError && (
        <p role="alert" className="text-sm text-destructive">
          {actionError}
        </p>
      )}

      {listError ? (
        <p role="alert" className="text-sm text-destructive">
          {listError}
        </p>
      ) : loading ? (
        <p className="text-sm text-muted-foreground">Loading notes…</p>
      ) : notes.length === 0 ? (
        // Empty vault → empty-state message (Req 3.7).
        <p className="text-center text-sm text-muted-foreground">
          No notes yet. Create a resource note to get started.
        </p>
      ) : (
        // Responsive card grid: one column on narrow windows, more as space
        // allows. `auto-rows-fr` keeps cards in a row the same height.
        <ul className="grid auto-rows-fr grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {notes.map((note) => (
            <li key={note.id} className="min-w-0">
              <NoteListItem
                note={note}
                onOpen={() => void openNote(note.id)}
                onRename={(title) => void renameNote(note.id, title)}
                onDelete={() => setPendingDelete(note)}
              />
            </li>
          ))}
        </ul>
      )}

      {/* Delete confirmation — destructive, so we confirm before removing the
          note file from disk. */}
      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(next) => !next && setPendingDelete(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete note?</DialogTitle>
            <DialogDescription>
              <span className="font-medium text-foreground">{deleteLabel}</span>{' '}
              will be permanently deleted from this vault. This can’t be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingDelete(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void confirmDelete()}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
