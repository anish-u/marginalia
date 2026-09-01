/**
 * Example (not property) tests for the `VaultManager` dialog flow, the
 * adopt-existing-vault path, last-active persistence, and boot restore
 * (task 5.4). These complement the property tests in `vault-manager.test.ts`,
 * which cover the pure `designateVault`/`recognizeVault` core; here we drive the
 * *class* — `create()`, `open()`, `getActive()`, `restore()` — through its two
 * injectable seams so the whole flow runs without a live Electron app:
 *
 *   - `showOpenDialog` is a `vi.fn()` returning either a chosen folder or a
 *     cancel, standing in for `dialog.showOpenDialog` (design → Testing
 *     Strategy: the dialog is a seam precisely so cancel / adopt / error flows
 *     are exercisable with no folder picker).
 *   - `userDataDir` points at a fresh OS temp dir, so `vault-state.json` is
 *     written and read there instead of the real `userData`.
 *
 * Vault folders are real directories under `os.tmpdir()`, created fresh per test
 * and removed after, so marker writes and adopt-without-overwrite assertions
 * exercise the actual filesystem.
 *
 * Validates: Requirements 1.1, 1.4, 1.6, 2.1, 2.5
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { OpenDialogReturnValue } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { VaultInfo } from '@shared/resource-note';

import {
  MARKER_DIR,
  MARKER_FILE,
  VaultManager,
  designateVault,
  type ShowOpenDialog,
} from '@main/vault/vault-manager';

/** Scratch root for both vault folders and the injected `userDataDir`. */
let scratch: string;
/** The temp dir passed as `userDataDir` — where `vault-state.json` lands. */
let userDataDir: string;

beforeEach(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'marginalia-vm-'));
  userDataDir = path.join(scratch, 'userData');
  await fs.mkdir(userDataDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(scratch, { recursive: true, force: true });
});

/** Create a fresh, empty, writable vault-candidate folder under the scratch. */
async function makeFolder(name: string): Promise<string> {
  const dir = path.join(scratch, name);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** Absolute path to a folder's marker file. */
function markerPath(dir: string): string {
  return path.join(dir, MARKER_DIR, MARKER_FILE);
}

/** A `showOpenDialog` seam that confirms with `dir`. */
function dialogReturns(dir: string): ShowOpenDialog {
  return vi.fn(
    async (): Promise<OpenDialogReturnValue> => ({
      canceled: false,
      filePaths: [dir],
    }),
  );
}

/** A `showOpenDialog` seam that reports a cancel. */
function dialogCanceled(): ShowOpenDialog {
  return vi.fn(
    async (): Promise<OpenDialogReturnValue> => ({
      canceled: true,
      filePaths: [],
    }),
  );
}

/** The `VaultInfo` a successful create/open should yield for `dir`. */
function vaultInfoFor(dir: string): VaultInfo {
  return { path: dir, name: path.basename(dir) };
}

/** Absolute path to the last-active pointer under the injected userDataDir. */
function stateFilePath(): string {
  return path.join(userDataDir, 'vault-state.json');
}

/** Read + parse `vault-state.json`, or `null` if it does not exist. */
async function readState(): Promise<{ lastVaultPath: string } | null> {
  try {
    return JSON.parse(await fs.readFile(stateFilePath(), 'utf8'));
  } catch {
    return null;
  }
}

describe('VaultManager.create() — cancel (Req 1.6)', () => {
  it('returns { ok: true, value: null } and leaves no active vault when cancelled', async () => {
    const showOpenDialog = dialogCanceled();
    const manager = new VaultManager({ showOpenDialog, userDataDir });

    const result = await manager.create();

    expect(result).toEqual({ ok: true, value: null });
    // Cancel is not an error and must not activate anything (Req 1.6).
    expect(manager.getActive()).toBeNull();
    // No state file is written on cancel.
    expect(await readState()).toBeNull();
  });

  it('leaves a previously-active vault unchanged when a later create is cancelled', async () => {
    const first = await makeFolder('create-cancel-prior');
    const manager = new VaultManager({
      // First call confirms `first`, second call cancels.
      showOpenDialog: vi
        .fn<ShowOpenDialog>()
        .mockResolvedValueOnce({ canceled: false, filePaths: [first] })
        .mockResolvedValueOnce({ canceled: true, filePaths: [] }),
      userDataDir,
    });

    // Establish an active vault first.
    const created = await manager.create();
    expect(created.ok).toBe(true);
    expect(manager.getActive()).toEqual(vaultInfoFor(first));

    // A subsequent cancelled create must leave that active vault untouched.
    const cancelled = await manager.create();
    expect(cancelled).toEqual({ ok: true, value: null });
    expect(manager.getActive()).toEqual(vaultInfoFor(first));
  });
});

describe('VaultManager.open() — cancel (Req 2.5)', () => {
  it('returns { ok: true, value: null } and leaves no active vault when cancelled', async () => {
    const manager = new VaultManager({
      showOpenDialog: dialogCanceled(),
      userDataDir,
    });

    const result = await manager.open();

    expect(result).toEqual({ ok: true, value: null });
    expect(manager.getActive()).toBeNull();
    expect(await readState()).toBeNull();
  });

  it('leaves a previously-active vault unchanged when a later open is cancelled', async () => {
    const vault = await makeFolder('open-cancel-prior');
    expect((await designateVault(vault)).ok).toBe(true);

    const manager = new VaultManager({
      // First open confirms the real vault, second open cancels.
      showOpenDialog: vi
        .fn<ShowOpenDialog>()
        .mockResolvedValueOnce({ canceled: false, filePaths: [vault] })
        .mockResolvedValueOnce({ canceled: true, filePaths: [] }),
      userDataDir,
    });

    const opened = await manager.open();
    expect(opened.ok).toBe(true);
    expect(manager.getActive()).toEqual(vaultInfoFor(vault));

    const cancelled = await manager.open();
    expect(cancelled).toEqual({ ok: true, value: null });
    expect(manager.getActive()).toEqual(vaultInfoFor(vault));
  });
});

describe('VaultManager.create() — adopt existing vault without overwriting (Req 1.4)', () => {
  it('adopts a folder that already has a marker, preserving its contents and marker', async () => {
    const dir = await makeFolder('adopt-existing');
    // Pre-designate the folder so it already carries a valid marker.
    expect((await designateVault(dir)).ok).toBe(true);

    // Capture the exact marker bytes so we can prove they are not rewritten.
    const markerBefore = await fs.readFile(markerPath(dir), 'utf8');

    // Drop a sentinel file inside the folder that adoption must NOT touch.
    const sentinel = path.join(dir, 'existing-note.md');
    const sentinelContents = '# pre-existing content that must survive';
    await fs.writeFile(sentinel, sentinelContents, 'utf8');

    const manager = new VaultManager({
      showOpenDialog: dialogReturns(dir),
      userDataDir,
    });

    const result = await manager.create();

    // Adoption succeeds and yields the folder as the active vault (Req 1.4).
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual(vaultInfoFor(dir));
    expect(manager.getActive()).toEqual(vaultInfoFor(dir));

    // The sentinel file's contents are untouched — no overwrite of vault data.
    expect(await fs.readFile(sentinel, 'utf8')).toBe(sentinelContents);
    // The marker is unchanged — adoption does not re-designate.
    expect(await fs.readFile(markerPath(dir), 'utf8')).toBe(markerBefore);
    // The path is still persisted so it can be restored on boot.
    expect(await readState()).toEqual({ lastVaultPath: dir });
  });
});

describe('VaultManager.create() — fresh folder (Req 1.1, 1.2, 1.5)', () => {
  it('writes the marker, sets it active, and persists vault-state.json', async () => {
    const dir = await makeFolder('create-fresh');
    const manager = new VaultManager({
      showOpenDialog: dialogReturns(dir),
      userDataDir,
    });

    // No marker before create.
    await expect(fs.access(markerPath(dir))).rejects.toBeTruthy();

    const result = await manager.create();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual(vaultInfoFor(dir));
    expect(manager.getActive()).toEqual(vaultInfoFor(dir));

    // Marker is now present and is a valid Marginalia marker.
    const marker = JSON.parse(await fs.readFile(markerPath(dir), 'utf8'));
    expect(marker.marginaliaVault).toBe(true);

    // Last-active pointer persisted at the injected userData location.
    expect(await readState()).toEqual({ lastVaultPath: dir });
  });
});

describe('VaultManager.open() — recognition outcomes (Req 2.1, 2.3, 2.4)', () => {
  it('opening a valid vault sets it active and persists the pointer', async () => {
    const vault = await makeFolder('open-valid');
    expect((await designateVault(vault)).ok).toBe(true);

    const manager = new VaultManager({
      showOpenDialog: dialogReturns(vault),
      userDataDir,
    });

    const result = await manager.open();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual(vaultInfoFor(vault));
    expect(manager.getActive()).toEqual(vaultInfoFor(vault));
    expect(await readState()).toEqual({ lastVaultPath: vault });
  });

  it('opening a non-vault folder returns not-a-vault and leaves the active vault unchanged', async () => {
    const prior = await makeFolder('open-notavault-prior');
    expect((await designateVault(prior)).ok).toBe(true);
    const plain = await makeFolder('open-notavault-plain');

    const manager = new VaultManager({
      showOpenDialog: vi
        .fn<ShowOpenDialog>()
        // First open activates a real prior vault …
        .mockResolvedValueOnce({ canceled: false, filePaths: [prior] })
        // … second open targets a marker-less folder.
        .mockResolvedValueOnce({ canceled: false, filePaths: [plain] }),
      userDataDir,
    });

    expect((await manager.open()).ok).toBe(true);
    expect(manager.getActive()).toEqual(vaultInfoFor(prior));

    const result = await manager.open();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('not-a-vault');
    // Active vault untouched on failure (Req 2.3).
    expect(manager.getActive()).toEqual(vaultInfoFor(prior));
    // The persisted pointer still points at the prior vault, not the plain one.
    expect(await readState()).toEqual({ lastVaultPath: prior });
  });

  it('opening a folder with a malformed marker returns vault-unreadable and leaves the active vault unchanged', async () => {
    const broken = await makeFolder('open-broken');
    // A marker file that exists but does not parse as a valid vault marker.
    await fs.mkdir(path.join(broken, MARKER_DIR), { recursive: true });
    await fs.writeFile(markerPath(broken), 'not json at all {{{', 'utf8');

    const manager = new VaultManager({
      showOpenDialog: dialogReturns(broken),
      userDataDir,
    });

    const result = await manager.open();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('vault-unreadable');
    // Nothing was activated; no pointer persisted (Req 2.4).
    expect(manager.getActive()).toBeNull();
    expect(await readState()).toBeNull();
  });
});

describe('VaultManager.restore() — boot restore of the last-active vault', () => {
  it('restores a valid vault referenced by vault-state.json and sets it active', async () => {
    const vault = await makeFolder('restore-valid');
    expect((await designateVault(vault)).ok).toBe(true);
    // Seed a pointer file at the injected userData location.
    await fs.writeFile(
      stateFilePath(),
      JSON.stringify({ lastVaultPath: vault }),
      'utf8',
    );

    // A dialog seam that must never be called during restore.
    const showOpenDialog = vi.fn<ShowOpenDialog>();
    const manager = new VaultManager({ showOpenDialog, userDataDir });

    const restored = await manager.restore();

    expect(restored).toEqual(vaultInfoFor(vault));
    expect(manager.getActive()).toEqual(vaultInfoFor(vault));
    expect(showOpenDialog).not.toHaveBeenCalled();
  });

  it('ignores a stale pointer whose folder no longer exists', async () => {
    const gone = path.join(scratch, 'restore-deleted-vault');
    // Never created (or imagine it was deleted): the pointer is stale.
    await fs.writeFile(
      stateFilePath(),
      JSON.stringify({ lastVaultPath: gone }),
      'utf8',
    );

    const manager = new VaultManager({
      showOpenDialog: vi.fn<ShowOpenDialog>(),
      userDataDir,
    });

    expect(await manager.restore()).toBeNull();
    expect(manager.getActive()).toBeNull();
  });

  it('ignores a pointer to a folder that exists but is not a vault', async () => {
    const notAVault = await makeFolder('restore-not-a-vault');
    await fs.writeFile(
      stateFilePath(),
      JSON.stringify({ lastVaultPath: notAVault }),
      'utf8',
    );

    const manager = new VaultManager({
      showOpenDialog: vi.fn<ShowOpenDialog>(),
      userDataDir,
    });

    expect(await manager.restore()).toBeNull();
    expect(manager.getActive()).toBeNull();
  });

  it('returns null when the state file is missing (first run)', async () => {
    // No vault-state.json written at all.
    const manager = new VaultManager({
      showOpenDialog: vi.fn<ShowOpenDialog>(),
      userDataDir,
    });

    expect(await manager.restore()).toBeNull();
    expect(manager.getActive()).toBeNull();
  });
});
