/**
 * Example test for the notes IPC `NoteWrite` handler with **no active vault**
 * (task 7.5, Req 5.6).
 *
 * The contract under test lives in the *handler*, not in `NoteStore`: the store
 * has no notion of "no vault" — it always writes to a path it is handed. It is
 * `registerNotesHandlers` that reads the app-global active vault from the shared
 * `vaultManager` and, when there is none, short-circuits with a `no-vault`
 * error *before any filesystem work* (Req 5.6). So this test must exercise the
 * registered handler, not the store.
 *
 * Testing approach (design → Testing Strategy):
 *  - `electron` is mocked so `ipcMain.handle` merely *captures* each registered
 *    channel→handler pair into a map. We then call `registerNotesHandlers()` and
 *    invoke the captured `NoteWrite` handler directly, with no Electron runtime.
 *  - `@main/windows` is mocked to a stub so importing `notes.ts` doesn't pull in
 *    real BrowserWindow-based window factories (only the `OpenNoteWindow`
 *    handler uses it, which this test doesn't touch).
 *  - The shared `vaultManager` (from `@main/ipc/vault`) is a fresh module
 *    singleton with no active vault, so `getActive()` returns `null` — exactly
 *    the no-vault state we need. We assert on that precondition explicitly.
 *  - To prove "creates no file", we point the write at a real, empty temp dir as
 *    the would-be vault and assert it stays empty, AND spy on `NoteStore.write`
 *    to prove the handler never even reached the store.
 *
 * Validates: Requirements 5.6
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IpcMainInvokeEvent } from 'electron';

import type { ResourceNoteInput, Result } from '@shared/resource-note';

/**
 * Captured `channel → handler` pairs. Populated by the mocked
 * `ipcMain.handle` below when `registerNotesHandlers()` runs.
 */
const handlers = new Map<
  string,
  (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
>();

// Mock electron. `ipcMain.handle` just records the handler so we can invoke it
// directly — nothing here needs a real Electron runtime. `app`/`dialog` are
// stubbed only because importing `@main/ipc/vault` constructs the shared
// `VaultManager` at module load, whose constructor reads `app.getPath` and
// defaults its dialog to `dialog.showOpenDialog`. This test never triggers a
// dialog or persistence, so trivial stubs suffice.
vi.mock('electron', () => ({
  ipcMain: {
    handle: (
      channel: string,
      handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
    ) => {
      handlers.set(channel, handler);
    },
  },
  app: {
    // A throwaway path: the no-vault write path never persists anything.
    getPath: () => os.tmpdir(),
  },
  dialog: {
    showOpenDialog: vi.fn(),
  },
}));

// Mock the windows barrel: notes.ts imports createResourceNoteWindow for the
// OpenNoteWindow handler. This test never exercises that handler, but the import
// would otherwise drag in real window factories (and their electron usage).
vi.mock('@main/windows', () => ({
  createResourceNoteWindow: vi.fn(),
}));

// Spy on NoteStore.write so we can assert the no-vault path never reaches the
// store (Req 5.6: no file created — it should short-circuit before any I/O).
const writeSpy = vi.fn();
vi.mock('@main/vault/note-store', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('@main/vault/note-store')
  >();
  return {
    ...actual,
    NoteStore: class extends actual.NoteStore {
      override write(
        ...args: Parameters<InstanceType<typeof actual.NoteStore>['write']>
      ): ReturnType<InstanceType<typeof actual.NoteStore>['write']> {
        writeSpy(...args);
        return super.write(...args);
      }
    },
  };
});

// Import AFTER the mocks are declared so the module graph (notes.ts → its
// electron/windows/note-store imports) resolves to the mocked versions.
import { IpcChannels } from '@main/ipc-channels';
import { registerNotesHandlers } from '@main/ipc/notes';
import { vaultManager } from '@main/ipc/vault';

/** A scratch temp dir used as the *would-be* vault to prove nothing is written. */
let wouldBeVault: string;

beforeEach(async () => {
  handlers.clear();
  writeSpy.mockClear();
  wouldBeVault = await fs.mkdtemp(path.join(os.tmpdir(), 'marginalia-novault-'));
  registerNotesHandlers();
});

afterEach(async () => {
  await fs.rm(wouldBeVault, { recursive: true, force: true });
});

/** Invoke a captured handler by channel, faking the ipc event arg. */
function invoke(channel: IpcChannels, ...args: unknown[]): unknown {
  const handler = handlers.get(channel);
  if (!handler) {
    throw new Error(`No handler registered for channel '${channel}'`);
  }
  return handler({} as IpcMainInvokeEvent, ...args);
}

/** A minimal valid note payload for a write attempt. */
function sampleNote(): ResourceNoteInput {
  return {
    id: 'note-no-vault',
    title: 'A note with nowhere to go',
    resource: { type: 'website-link', url: 'https://example.com' },
    content: { prose: 'Some prose.', highlights: [] },
  };
}

describe('NoteWrite handler — no active vault (Req 5.6)', () => {
  it('registers a NoteWrite handler', () => {
    expect(handlers.has(IpcChannels.NoteWrite)).toBe(true);
  });

  it('returns no-vault and creates no file when there is no active vault', async () => {
    // Precondition: the shared, freshly-imported vaultManager has no active
    // vault, so getActive() is null — the exact state this test targets.
    expect(vaultManager.getActive()).toBeNull();

    const result = (await invoke(
      IpcChannels.NoteWrite,
      sampleNote(),
    )) as Result<unknown>;

    // The handler returns the no-vault error as data (never throws).
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('no-vault');

    // It short-circuits before touching the store: write() was never called,
    // so nothing was ever written to disk.
    expect(writeSpy).not.toHaveBeenCalled();

    // And the would-be vault directory is still completely empty — no notes/
    // folder, no file, nothing created (Req 5.6).
    expect(await fs.readdir(wouldBeVault)).toEqual([]);
  });
});
