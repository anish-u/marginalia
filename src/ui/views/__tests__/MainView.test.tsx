// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

/**
 * RTL + jsdom tests for the notes-list UI states (task 9.3).
 *
 * These exercise the renderer's notes-list surface end-to-end through the
 * preload bridge, which is the only way the renderer talks to the main process.
 * `window.marginalia` is stubbed as a full {@link MarginaliaApi} of `vi.fn()`s;
 * each test wires only the methods it cares about and leaves the rest as inert
 * stubs. Because the real data-fetching (`getActiveVault`, `listNotes`) is
 * async, assertions use `findBy*`/`waitFor` and MainView renders nothing until
 * the initial `getActiveVault()` resolves.
 *
 * Coverage (per the acceptance criteria):
 *   - No active vault → create/open actions render                     (Req 3.2)
 *   - Empty vault → empty-state message                                (Req 3.7)
 *   - Whitespace/empty title → placeholder shown                       (Req 3.5)
 *   - Website-link type indicator renders per item                     (Req 3.4)
 *   - Open failure → inline error, entries left unchanged              (Req 3.8)
 *   - VaultChanged → list refreshes + selection/errors cleared         (Req 3.3)
 *
 * The item-level cases (3.5, 3.4) are asserted through `NotesListView` /
 * `NoteListItem` directly where that reads cleaner; the vault-level cases
 * (3.2, 3.3, 3.7) go through `MainView` so the `getActiveVault` + `onVaultChanged`
 * wiring is covered too.
 *
 * Validates: Requirements 3.2, 3.3, 3.4, 3.5, 3.7, 3.8
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NoteListItem, DEFAULT_TITLE_PLACEHOLDER } from '@/components/notes/NoteListItem';
import { NotesListView } from '@/components/notes/NotesListView';
import { MainView } from '@ui/views/MainView';
import type { MarginaliaApi, NotesChangedInfo } from '@shared/ipc';
import type {
  Result,
  ResourceNoteSummary,
  VaultInfo,
} from '@shared/resource-note';

// --- Test helpers ----------------------------------------------------------

const vault = (over: Partial<VaultInfo> = {}): VaultInfo => ({
  path: '/tmp/my-vault',
  name: 'my-vault',
  ...over,
});

const summary = (over: Partial<ResourceNoteSummary> = {}): ResourceNoteSummary => ({
  id: 'note-1',
  title: 'A note',
  resourceType: 'website-link',
  modifiedAt: 1_000,
  ...over,
});

const listOk = (notes: ResourceNoteSummary[]): Result<ResourceNoteSummary[]> => ({
  ok: true,
  value: notes,
});

/** No-op handlers for the row's open/rename/delete props in item-level tests. */
const noop = {
  onOpen: () => {},
  onRename: () => {},
  onDelete: () => {},
};

/**
 * Build a full `MarginaliaApi` stub. `onVaultChanged` records the last
 * subscribed callback on `capturedVaultChange` so tests can invoke it to
 * simulate a main-process `VaultChanged` broadcast; it returns a disposer spy.
 */
let capturedVaultChange: ((vault: VaultInfo | null) => void) | undefined;
let vaultChangeDisposer: () => void;
// Captures the last `onNotesChanged` subscriber so tests can simulate a
// main-process NotesChanged broadcast (optionally carrying rename info).
let capturedNotesChange:
  | ((rename: NotesChangedInfo | null) => void)
  | undefined;

const makeApi = (over: Partial<MarginaliaApi> = {}): MarginaliaApi => {
  capturedVaultChange = undefined;
  capturedNotesChange = undefined;
  vaultChangeDisposer = vi.fn();

  return {
    getAppVersion: vi.fn().mockResolvedValue('1.2.3'),
    openResourceNoteWindow: vi.fn().mockResolvedValue(undefined),
    setTheme: vi.fn().mockResolvedValue(undefined),
    onThemeChanged: vi.fn().mockReturnValue(vi.fn()),

    createVault: vi.fn().mockResolvedValue({ ok: true, value: null }),
    openVault: vi.fn().mockResolvedValue({ ok: true, value: null }),
    getActiveVault: vi.fn().mockResolvedValue(null),
    onVaultChanged: vi.fn((cb: (vault: VaultInfo | null) => void): (() => void) => {
      capturedVaultChange = cb;
      return vaultChangeDisposer;
    }),
    listNotes: vi.fn().mockResolvedValue(listOk([])),
    readNote: vi.fn(),
    writeNote: vi.fn(),
    deleteNote: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    renameNote: vi.fn(),
    allocateNoteId: vi.fn().mockResolvedValue(null),
    openNoteWindow: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    onNotesChanged: vi.fn(
      (cb: (rename: NotesChangedInfo | null) => void): (() => void) => {
        capturedNotesChange = cb;
        return vi.fn();
      },
    ),
    ...over,
  };
};

const installApi = (over: Partial<MarginaliaApi> = {}): MarginaliaApi => {
  const api = makeApi(over);
  window.marginalia = api;
  return api;
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// --- No active vault: create/open actions (Req 3.2) ------------------------

describe('MainView — no active vault', () => {
  it('renders create/open actions when no vault is active (Req 3.2)', async () => {
    installApi({ getActiveVault: vi.fn().mockResolvedValue(null) });

    render(<MainView />);

    expect(
      await screen.findByRole('button', { name: /create vault/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /open vault/i }),
    ).toBeInTheDocument();
  });
});

// --- Empty vault: empty-state message (Req 3.7) ----------------------------

describe('MainView — empty vault', () => {
  it('shows the empty-state message when the active vault has no notes (Req 3.7)', async () => {
    installApi({
      getActiveVault: vi.fn().mockResolvedValue(vault()),
      listNotes: vi.fn().mockResolvedValue(listOk([])),
    });

    render(<MainView />);

    expect(await screen.findByText(/no notes yet/i)).toBeInTheDocument();
    // Not the empty state — a vault is active.
    expect(
      screen.queryByRole('button', { name: /create vault/i }),
    ).not.toBeInTheDocument();
  });
});

// --- Whitespace/empty title: placeholder (Req 3.5) -------------------------

describe('NoteListItem — blank titles', () => {
  it.each([
    ['empty string', ''],
    ['whitespace only', '   '],
  ])('renders the placeholder for a %s title (Req 3.5)', (_label, title) => {
    render(<NoteListItem note={summary({ title })} {...noop} />);

    expect(screen.getByText(DEFAULT_TITLE_PLACEHOLDER)).toBeInTheDocument();
  });

  it('renders the real title when present (Req 3.5)', () => {
    render(<NoteListItem note={summary({ title: 'Real title' })} {...noop} />);

    expect(screen.getByText('Real title')).toBeInTheDocument();
    expect(screen.queryByText(DEFAULT_TITLE_PLACEHOLDER)).not.toBeInTheDocument();
  });
});

// --- Website-link type indicator (Req 3.4) ---------------------------------

describe('NoteListItem / NotesListView — resource-type indicator', () => {
  it('renders the website-link indicator for an item (Req 3.4)', () => {
    render(<NoteListItem note={summary()} {...noop} />);

    expect(screen.getByLabelText('Website link note')).toBeInTheDocument();
  });

  it('renders one indicator per note in the list (Req 3.4)', async () => {
    installApi({
      listNotes: vi
        .fn()
        .mockResolvedValue(
          listOk([
            summary({ id: 'a', title: 'First' }),
            summary({ id: 'b', title: 'Second' }),
          ]),
        ),
    });

    render(<NotesListView vault={vault()} />);

    await screen.findByText('First');
    expect(screen.getAllByLabelText('Website link note')).toHaveLength(2);
  });
});

// --- Open failure: inline error, entries unchanged (Req 3.8) ---------------

describe('NotesListView — open failure', () => {
  it('shows an inline error and leaves entries unchanged when open fails (Req 3.8)', async () => {
    const notes = [
      summary({ id: 'a', title: 'First' }),
      summary({ id: 'b', title: 'Second' }),
    ];
    installApi({
      listNotes: vi.fn().mockResolvedValue(listOk(notes)),
      openNoteWindow: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: 'note-not-found', message: 'That note could not be opened.' },
      }),
    });

    render(<NotesListView vault={vault()} />);

    const firstItem = await screen.findByText('First');
    fireEvent.click(firstItem);

    // Inline error surfaced via role="alert".
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/could not be opened/i);

    // Entries are still present and unchanged.
    expect(screen.getByText('First')).toBeInTheDocument();
    expect(screen.getByText('Second')).toBeInTheDocument();
    expect(screen.getAllByLabelText('Website link note')).toHaveLength(2);
  });
});

// --- VaultChanged refresh + clears selection/errors (Req 3.3) --------------

describe('MainView — vault change', () => {
  it('refreshes the list and clears prior error when the active vault changes (Req 3.3)', async () => {
    // Start on vault A with one note; opening it fails so an inline error shows.
    const listNotes = vi
      .fn<() => Promise<Result<ResourceNoteSummary[]>>>()
      .mockResolvedValueOnce(listOk([summary({ id: 'a', title: 'From A' })]))
      .mockResolvedValueOnce(listOk([summary({ id: 'b', title: 'From B' })]));

    installApi({
      getActiveVault: vi.fn().mockResolvedValue(vault({ name: 'vault-a', path: '/tmp/a' })),
      listNotes,
      openNoteWindow: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: 'note-not-found', message: 'Nope.' },
      }),
    });

    render(<MainView />);

    // Vault A rendered.
    expect(await screen.findByText('From A')).toBeInTheDocument();
    expect(await screen.findByText('vault-a')).toBeInTheDocument();

    // Trigger an open failure so there's a lingering error to clear.
    fireEvent.click(screen.getByText('From A'));
    expect(await screen.findByRole('alert')).toBeInTheDocument();

    // Simulate a VaultChanged broadcast to a NEW vault.
    expect(capturedVaultChange).toBeDefined();
    capturedVaultChange!(vault({ name: 'vault-b', path: '/tmp/b' }));

    // The list re-fetches (2nd listNotes call) and reflects the new vault.
    await waitFor(() => expect(listNotes).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('From B')).toBeInTheDocument();
    expect(await screen.findByText('vault-b')).toBeInTheDocument();

    // Prior entry and prior open-error are gone (selection/errors cleared).
    expect(screen.queryByText('From A')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('swaps to the empty state when the active vault is cleared (Req 3.2/3.3)', async () => {
    installApi({
      getActiveVault: vi.fn().mockResolvedValue(vault()),
      listNotes: vi.fn().mockResolvedValue(listOk([summary({ title: 'Only note' })])),
    });

    render(<MainView />);
    await screen.findByText('Only note');

    // Broadcast a cleared vault.
    capturedVaultChange!(null);

    expect(
      await screen.findByRole('button', { name: /create vault/i }),
    ).toBeInTheDocument();
  });
});

// --- Delete a note (with confirmation) -------------------------------------

describe('NotesListView — delete', () => {
  it('confirms, then deletes the note and refreshes the list', async () => {
    const deleteNote = vi
      .fn<(id: string) => Promise<Result<void>>>()
      .mockResolvedValue({ ok: true, value: undefined });
    const listNotes = vi
      .fn<() => Promise<Result<ResourceNoteSummary[]>>>()
      // Initial list has the note; after delete, it's gone.
      .mockResolvedValueOnce(listOk([summary({ id: 'a', title: 'Doomed' })]))
      .mockResolvedValue(listOk([]));

    installApi({ listNotes, deleteNote });

    render(<NotesListView vault={vault()} />);

    // Trigger delete on the row, then confirm in the dialog.
    fireEvent.click(await screen.findByRole('button', { name: /delete doomed/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^delete$/i }));

    await waitFor(() => expect(deleteNote).toHaveBeenCalledWith('a'));
    // List refreshed and the note is gone.
    expect(await screen.findByText(/no notes yet/i)).toBeInTheDocument();
    expect(screen.queryByText('Doomed')).not.toBeInTheDocument();
  });

  it('does not delete when the confirmation is cancelled', async () => {
    const deleteNote = vi.fn();
    installApi({
      listNotes: vi.fn().mockResolvedValue(listOk([summary({ id: 'a', title: 'Safe' })])),
      deleteNote,
    });

    render(<NotesListView vault={vault()} />);

    fireEvent.click(await screen.findByRole('button', { name: /delete safe/i }));
    fireEvent.click(await screen.findByRole('button', { name: /cancel/i }));

    expect(deleteNote).not.toHaveBeenCalled();
    expect(screen.getByText('Safe')).toBeInTheDocument();
  });
});

// --- Rename a note ---------------------------------------------------------

describe('NotesListView — rename', () => {
  it('renames a note inline and persists the new title', async () => {
    const renameNote = vi
      .fn<(id: string, title: string) => Promise<Result<never>>>()
      .mockResolvedValue({ ok: true } as never);
    const listNotes = vi
      .fn<() => Promise<Result<ResourceNoteSummary[]>>>()
      .mockResolvedValueOnce(listOk([summary({ id: 'a', title: 'Old name' })]))
      .mockResolvedValue(listOk([summary({ id: 'a', title: 'New name' })]));

    installApi({ listNotes, renameNote });

    render(<NotesListView vault={vault()} />);

    fireEvent.click(await screen.findByRole('button', { name: /rename old name/i }));
    const field = await screen.findByRole('textbox', { name: /note title/i });
    fireEvent.change(field, { target: { value: 'New name' } });
    fireEvent.click(screen.getByRole('button', { name: /save title/i }));

    await waitFor(() => expect(renameNote).toHaveBeenCalledWith('a', 'New name'));
    expect(await screen.findByText('New name')).toBeInTheDocument();
  });
});

// --- NotesChanged broadcast refreshes the list -----------------------------

describe('NotesListView — notes changed broadcast', () => {
  it('re-fetches when a NotesChanged broadcast arrives (e.g. a note saved elsewhere)', async () => {
    const listNotes = vi
      .fn<() => Promise<Result<ResourceNoteSummary[]>>>()
      .mockResolvedValueOnce(listOk([]))
      .mockResolvedValue(listOk([summary({ id: 'x', title: 'Saved elsewhere' })]));

    installApi({ listNotes });

    render(<NotesListView vault={vault()} />);
    expect(await screen.findByText(/no notes yet/i)).toBeInTheDocument();

    // A note window saved a new note → main broadcasts NotesChanged (no rename).
    expect(capturedNotesChange).toBeDefined();
    capturedNotesChange!(null);

    expect(await screen.findByText('Saved elsewhere')).toBeInTheDocument();
  });
});
