/**
 * Tests for the `NotesChanged` broadcast payloads emitted by the notes IPC
 * handlers. These payloads are what lets an open note window react precisely to
 * a change made elsewhere: reload its content when the same note was written in
 * another window, and adopt a new id after a rename. So the exact
 * `{ id }` / `{ id, oldId, newId }` shape is a contract worth locking down.
 *
 * Approach mirrors `notes.no-vault.test.ts`: mock `electron` so `ipcMain.handle`
 * captures the handlers and `BrowserWindow.getAllWindows()` returns one fake
 * window whose `webContents.send` we spy on; point the shared `vaultManager` at
 * a real temp vault via a spy on `getActive`; then invoke the captured handlers
 * and assert what was broadcast on the `notes:changed` channel.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IpcMainInvokeEvent } from 'electron';

import type {
  ResourceNoteInput,
  Result,
  ResourceNote,
} from '@shared/resource-note';

/** Captured `channel → handler` pairs, populated by the mocked ipcMain.handle. */
const handlers = new Map<
  string,
  (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
>();

/** Spy for the fake window's `webContents.send` — records every broadcast. */
const sendSpy = vi.fn();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (
      channel: string,
      handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
    ) => {
      handlers.set(channel, handler);
    },
  },
  // One fake window; broadcastNotesChanged iterates these and calls send().
  BrowserWindow: {
    getAllWindows: () => [{ webContents: { send: sendSpy } }],
  },
  app: { getPath: () => os.tmpdir() },
  dialog: { showOpenDialog: vi.fn() },
}));

// The watcher uses fs.watch; stub it so registering handlers doesn't start a
// real watch during the test.
vi.mock('@main/vault/notes-watcher', () => ({
  setNotesChangeHandler: vi.fn(),
  watchNotesDir: vi.fn(),
  // The write/delete/rename handlers now open the watcher's "app-write quiet
  // window" around each store mutation so the watcher doesn't echo our own
  // writes; stub it here so registering/invoking handlers doesn't blow up.
  markAppWrite: vi.fn(),
}));

vi.mock('@main/windows', () => ({
  createResourceNoteWindow: vi.fn(),
}));

import { IpcChannels } from '@main/ipc-channels';
import { registerNotesHandlers } from '@main/ipc/notes';
import { vaultManager } from '@main/ipc/vault';
// The mocked watcher module (declared above). Importing it gives us the `vi.fn`
// spies so we can assert the write handlers open the "app-write quiet window"
// exactly once per action.
import { markAppWrite } from '@main/vault/notes-watcher';

let vault: string;

beforeEach(async () => {
  handlers.clear();
  sendSpy.mockClear();
  vi.mocked(markAppWrite).mockClear();
  vault = await fs.mkdtemp(path.join(os.tmpdir(), 'marginalia-broadcast-'));
  // Point the shared manager at our temp vault for the duration of the test.
  vi.spyOn(vaultManager, 'getActive').mockReturnValue({
    path: vault,
    name: path.basename(vault),
  });
  registerNotesHandlers();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(vault, { recursive: true, force: true });
});

function invoke<T>(channel: IpcChannels, ...args: unknown[]): Promise<T> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler for '${channel}'`);
  return handler({} as IpcMainInvokeEvent, ...args) as Promise<T>;
}

function noteInput(id: string, title: string): ResourceNoteInput {
  return {
    id,
    title,
    resource: { type: 'website-link', url: 'https://example.com' },
    content: { prose: 'body', highlights: [] },
  };
}

/** Every payload broadcast on the notes:changed channel, in order. */
function notesChangedPayloads(): unknown[] {
  return sendSpy.mock.calls
    .filter((c) => c[0] === IpcChannels.NotesChanged)
    .map((c) => c[1]);
}

/** How many broadcasts landed on the notes:changed channel. */
function notesChangedCount(): number {
  return notesChangedPayloads().length;
}

/** The last payload broadcast on the notes:changed channel. */
function lastNotesChanged(): unknown {
  const payloads = notesChangedPayloads();
  return payloads.length ? payloads[payloads.length - 1] : undefined;
}

describe('notes IPC — NotesChanged broadcast payloads', () => {
  it('write broadcasts the written note id', async () => {
    const result = await invoke<Result<ResourceNote>>(
      IpcChannels.NoteWrite,
      noteInput('my-note', 'My Note'),
    );
    expect(result.ok).toBe(true);
    expect(lastNotesChanged()).toEqual({ id: 'my-note' });
  });

  it('delete broadcasts the deleted note id', async () => {
    await invoke(IpcChannels.NoteWrite, noteInput('doomed', 'Doomed'));
    sendSpy.mockClear();

    const result = await invoke<Result<void>>(IpcChannels.NoteDelete, 'doomed');
    expect(result.ok).toBe(true);
    expect(lastNotesChanged()).toEqual({ id: 'doomed' });
  });

  it('rename that moves the file broadcasts { id, oldId, newId }', async () => {
    await invoke(IpcChannels.NoteWrite, noteInput('old-title', 'Old Title'));
    sendSpy.mockClear();

    const result = await invoke<Result<ResourceNote>>(
      IpcChannels.NoteRename,
      'old-title',
      'Brand New',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.id).toBe('brand-new');
    expect(lastNotesChanged()).toEqual({
      id: 'brand-new',
      oldId: 'old-title',
      newId: 'brand-new',
    });
  });

  it('rename with an unchanged slug broadcasts just { id } (no move)', async () => {
    await invoke(IpcChannels.NoteWrite, noteInput('my-note', 'My Note'));
    sendSpy.mockClear();

    // "My Note!" still slugs to `my-note` → in-place rewrite, id unchanged.
    const result = await invoke<Result<ResourceNote>>(
      IpcChannels.NoteRename,
      'my-note',
      'My Note!',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.id).toBe('my-note');
    expect(lastNotesChanged()).toEqual({ id: 'my-note' });
  });
});

/**
 * A single in-app action must yield exactly one `NotesChanged` broadcast — not
 * two — and must suppress the On_Disk_Watcher's echo of the app's own write
 * (Req 3.1, 3.2). Two things prove the "one broadcast, no echo" contract at the
 * handler level:
 *
 *  1. The handler emits the explicit broadcast exactly once per action (counted
 *     on the `notes:changed` channel). The watcher module is mocked here, so it
 *     cannot add a second broadcast in this test — the watcher's own
 *     suppression logic is covered by the focused watcher unit test
 *     (`vault/__tests__/notes-watcher.test.ts`).
 *  2. The handler opens the watcher's "app-write quiet window" exactly once per
 *     action, immediately around the store mutation, so that when the real
 *     watcher *is* wired up the fs.watch events this write produces are dropped
 *     rather than re-broadcast. We assert `markAppWrite` was called once.
 */
describe('notes IPC — one broadcast per action, watcher echo suppressed', () => {
  it('a write emits exactly one broadcast and opens the quiet window once', async () => {
    const result = await invoke<Result<ResourceNote>>(
      IpcChannels.NoteWrite,
      noteInput('solo', 'Solo'),
    );
    expect(result.ok).toBe(true);
    // Exactly one notification for the single write, with the right payload.
    expect(notesChangedCount()).toBe(1);
    expect(lastNotesChanged()).toEqual({ id: 'solo' });
    // The watcher was told "this was us" once, so it won't echo the fs event.
    expect(markAppWrite).toHaveBeenCalledTimes(1);
  });

  it('a delete emits exactly one broadcast and opens the quiet window once', async () => {
    // Seed a note, then reset all counters so we measure only the delete.
    await invoke(IpcChannels.NoteWrite, noteInput('gone', 'Gone'));
    sendSpy.mockClear();
    vi.mocked(markAppWrite).mockClear();

    const result = await invoke<Result<void>>(IpcChannels.NoteDelete, 'gone');
    expect(result.ok).toBe(true);
    expect(notesChangedCount()).toBe(1);
    expect(lastNotesChanged()).toEqual({ id: 'gone' });
    expect(markAppWrite).toHaveBeenCalledTimes(1);
  });

  it('a rename that moves the file emits exactly one broadcast and opens the quiet window once', async () => {
    await invoke(IpcChannels.NoteWrite, noteInput('before', 'Before'));
    sendSpy.mockClear();
    vi.mocked(markAppWrite).mockClear();

    const result = await invoke<Result<ResourceNote>>(
      IpcChannels.NoteRename,
      'before',
      'After',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.id).toBe('after');
    // One broadcast carrying the id move — not one per fs event.
    expect(notesChangedCount()).toBe(1);
    expect(lastNotesChanged()).toEqual({
      id: 'after',
      oldId: 'before',
      newId: 'after',
    });
    expect(markAppWrite).toHaveBeenCalledTimes(1);
  });

  it('a rename with an unchanged slug still emits exactly one broadcast', async () => {
    await invoke(IpcChannels.NoteWrite, noteInput('stable', 'Stable'));
    sendSpy.mockClear();
    vi.mocked(markAppWrite).mockClear();

    // "Stable!" slugs back to `stable` → in-place rewrite, id unchanged.
    const result = await invoke<Result<ResourceNote>>(
      IpcChannels.NoteRename,
      'stable',
      'Stable!',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.id).toBe('stable');
    expect(notesChangedCount()).toBe(1);
    expect(lastNotesChanged()).toEqual({ id: 'stable' });
    expect(markAppWrite).toHaveBeenCalledTimes(1);
  });

  it('a failed write (no active vault) neither broadcasts nor opens the quiet window', async () => {
    // With no active vault the write short-circuits before any disk work, so
    // there is nothing for the watcher to echo and nothing to broadcast.
    vi.mocked(vaultManager.getActive).mockReturnValueOnce(null);

    const result = await invoke<Result<ResourceNote>>(
      IpcChannels.NoteWrite,
      noteInput('nowhere', 'Nowhere'),
    );
    expect(result.ok).toBe(false);
    expect(notesChangedCount()).toBe(0);
    expect(markAppWrite).not.toHaveBeenCalled();
  });
});
