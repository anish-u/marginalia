/**
 * Vault_Manager — main-process ownership of the vault marker, folder
 * recognition, the active-vault path, and last-active persistence.
 *
 * This first slice (task 5.1) implements only the **pure, UI-free**
 * recognition and marker-writing primitives:
 *
 *   - {@link recognizeVault} / {@link isVault} — decide whether a folder is a
 *     Marginalia vault by inspecting its marker.
 *   - {@link designateVault} — create the marker inside a folder.
 *
 * The Electron `dialog` flow, the `getActive`/`restore` lifecycle, and the
 * `userData` last-active persistence are deliberately kept *out* of these
 * functions and land later (task 5.3). Splitting the file-level marker logic
 * from the dialog/UI concerns is what lets these primitives be property-tested
 * against real temp directories without an Electron window or a mocked dialog
 * (design → Testing Strategy).
 *
 * The marker (design → "Vault marker") is a `.marginalia/` directory at the
 * vault root containing a `vault.json` file:
 *
 * ```json
 * { "marginaliaVault": true, "version": 1 }
 * ```
 *
 * A directory-based marker (rather than a single dotfile) leaves room for
 * future derived artifacts (e.g. an optional listing cache) without cluttering
 * the vault root. Recognition is precisely: "`.marginalia/vault.json` exists
 * and parses as JSON with `marginaliaVault: true`" (Req 1.3, 2.2).
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { app, dialog } from 'electron';
import type { OpenDialogOptions, OpenDialogReturnValue } from 'electron';

import type { Result, VaultError, VaultInfo } from '@shared/resource-note';

/** Marker directory name at the vault root. */
export const MARKER_DIR = '.marginalia';

/** Marker file name inside {@link MARKER_DIR}. */
export const MARKER_FILE = 'vault.json';

/** Current marker schema version written by {@link designateVault}. */
export const MARKER_VERSION = 1;

/**
 * Shape of the on-disk marker file. `marginaliaVault: true` is the recognition
 * signal; `version` allows future migrations of the marker format itself.
 */
interface VaultMarker {
  marginaliaVault: true;
  version: number;
}

/**
 * The outcome of inspecting a folder's marker. This richer result (rather than
 * a bare boolean) is what lets the caller distinguish the two failure modes the
 * open flow must report differently (design → Error Handling table):
 *
 * - `'vault'`        — the marker exists and is a valid Marginalia marker.
 * - `'not-a-vault'`  — no marker file is present (Req 2.3 → `not-a-vault`).
 * - `'unreadable'`   — a marker file exists but cannot be read or does not
 *                      parse as a valid marker (Req 2.4 → `vault-unreadable`).
 *
 * {@link isVault} collapses this to a boolean for the simple "is this a vault?"
 * question; task 5.3's `open()` uses {@link recognizeVault} directly so it can
 * map `'not-a-vault'` vs `'unreadable'` onto the correct {@link VaultError}.
 */
export type VaultRecognition = 'vault' | 'not-a-vault' | 'unreadable';

/** Absolute path to a folder's marker file. */
function markerPath(dir: string): string {
  return path.join(dir, MARKER_DIR, MARKER_FILE);
}

/**
 * Type guard: does a parsed JSON value look like a valid vault marker? We only
 * require the `marginaliaVault: true` signal; a missing/other `version` still
 * counts as a vault (forward-compatible) but a wrong `marginaliaVault` does not.
 */
function isValidMarker(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { marginaliaVault?: unknown }).marginaliaVault === true
  );
}

/**
 * Inspect a folder and classify it as a vault, a non-vault, or an unreadable
 * vault, without any UI (Req 1.3, 2.2, 2.3, 2.4).
 *
 * The distinction between "no marker" and "marker present but broken" is
 * deliberate: an absent marker means the user simply picked an ordinary folder
 * (`not-a-vault`), whereas a present-but-corrupt marker means a real vault the
 * app cannot currently open (`unreadable`). The open flow surfaces these as two
 * different errors.
 *
 * This function never mutates the folder — it only reads the marker file.
 */
export async function recognizeVault(dir: string): Promise<VaultRecognition> {
  let raw: string;
  try {
    raw = await fs.readFile(markerPath(dir), 'utf8');
  } catch (err) {
    // ENOENT means the marker file (or its `.marginalia` dir) is simply absent:
    // an ordinary, un-designated folder. Any other read error (permissions,
    // I/O) means a marker likely exists but cannot be read → unreadable.
    if (isNotFound(err)) {
      return 'not-a-vault';
    }
    return 'unreadable';
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // The file exists but is not valid JSON → a real vault we cannot open.
    return 'unreadable';
  }

  return isValidMarker(parsed) ? 'vault' : 'unreadable';
}

/**
 * Boolean convenience over {@link recognizeVault}: `true` only when the folder
 * carries a valid, readable marker (Req 1.3, 2.2).
 *
 * Note this returns `false` for an *unreadable* marker too — callers that must
 * tell "not a vault" apart from "unreadable vault" (the open flow) should use
 * {@link recognizeVault} instead.
 */
export async function isVault(dir: string): Promise<boolean> {
  return (await recognizeVault(dir)) === 'vault';
}

/**
 * Designate a folder as a vault by writing the marker (Req 1.2, 1.3).
 *
 * Creates `<dir>/.marginalia/` (recursively, tolerating an existing dir) and
 * writes `vault.json` with `{ marginaliaVault: true, version: MARKER_VERSION }`.
 * On any filesystem failure (unwritable folder, permission error) it returns a
 * `marker-create-failed` {@link VaultError} rather than throwing, so the caller
 * can leave the active vault unchanged (Req 1.7).
 *
 * This is intentionally I/O-only and UI-free: it neither prompts for a folder
 * nor sets the active vault. The dialog + adopt-existing-vault logic (Req 1.4)
 * lives in task 5.3, which calls {@link recognizeVault} first and only invokes
 * this when the folder is not already a vault.
 */
export async function designateVault(dir: string): Promise<Result<void>> {
  const marker: VaultMarker = {
    marginaliaVault: true,
    version: MARKER_VERSION,
  };

  try {
    await fs.mkdir(path.join(dir, MARKER_DIR), { recursive: true });
    await fs.writeFile(
      markerPath(dir),
      // Pretty-print so the marker is legible if a user opens it (Req 7.1 spirit).
      `${JSON.stringify(marker, null, 2)}\n`,
      'utf8',
    );
  } catch (err) {
    const error: VaultError = {
      code: 'marker-create-failed',
      message: `Could not create vault marker in '${dir}': ${errorMessage(err)}`,
    };
    return { ok: false, error };
  }

  return { ok: true, value: undefined };
}

/** Whether a caught filesystem error is a "no such file/directory" error. */
function isNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/* -------------------------------------------------------------------------- *
 * VaultManager — dialog flow, active-vault state, last-active persistence
 * -------------------------------------------------------------------------- */

/** File under `userData` that records which vault was last active (design). */
const VAULT_STATE_FILE = 'vault-state.json';

/**
 * On-disk shape of `<userData>/vault-state.json` (design → "Last-active-vault
 * pointer"). Only the last vault *path* is stored — this is a pointer to app
 * state, not note data, so it does not violate "no database for notes"
 * (Req 7.2). The vault folder itself remains the single source of truth.
 */
interface VaultState {
  lastVaultPath: string;
}

/**
 * The `dialog.showOpenDialog` seam. Declaring the single method the manager
 * needs (rather than reaching for Electron's `dialog` directly) is what lets
 * task 5.4 exercise the create/open flows — including cancel and
 * adopt-existing-vault — without a running Electron app or a real folder
 * picker. The signature is structurally compatible with Electron's
 * `dialog.showOpenDialog`, so the real function is assignable as-is.
 */
export type ShowOpenDialog = (
  options: OpenDialogOptions,
) => Promise<OpenDialogReturnValue>;

/**
 * Injectable seams for {@link VaultManager}. Both default to the real Electron
 * APIs (see {@link VaultManager.constructor}), but tests pass overrides so the
 * dialog can be mocked and the state file can be redirected into a temp dir —
 * no Electron window, no touching the user's real `userData` (design → Testing
 * Strategy).
 */
export interface VaultManagerDeps {
  /** Folder-picker seam; defaults to Electron's `dialog.showOpenDialog`. */
  showOpenDialog: ShowOpenDialog;
  /**
   * Directory where `vault-state.json` lives; defaults to
   * `app.getPath('userData')`. Injectable so tests point it at a temp dir.
   */
  userDataDir: string;
}

/**
 * Owns the active-vault path, the marker create/open dialog flows, and
 * last-active-vault persistence (design → "Vault_Manager").
 *
 * State is a single in-memory {@link VaultInfo} (`active`) — "at most one vault
 * is active at a time" (Req 2.2) falls straight out of a single field that
 * create/open overwrite and that {@link getActive} reads. This class does *not*
 * broadcast `VaultChanged`; that fan-out lives in `ipc/vault.ts` (task 7.3),
 * which calls these methods and sends the result to every window. Keeping the
 * `webContents` concern out of here keeps the manager unit-testable without a
 * renderer.
 *
 * The Electron `dialog` and the `userData` location are reached through
 * {@link VaultManagerDeps} seams so the whole flow can be tested with a mocked
 * picker and a temp state dir (task 5.4).
 */
export class VaultManager {
  private readonly showOpenDialog: ShowOpenDialog;
  private readonly userDataDir: string;

  /** The single active vault, or `null` when none is active (Req 2.2, 2.6). */
  private active: VaultInfo | null = null;

  /**
   * @param deps Optional seams. Both default to the real Electron APIs so
   * production code constructs `new VaultManager()` with no arguments; tests
   * pass a mocked `showOpenDialog` and a temp `userDataDir`. `app.getPath` is
   * read lazily (only when a seam is omitted) so merely importing this module
   * in a non-Electron test process does not require `app` to be ready.
   */
  constructor(deps: Partial<VaultManagerDeps> = {}) {
    this.showOpenDialog = deps.showOpenDialog ?? ((options) =>
      dialog.showOpenDialog(options));
    this.userDataDir = deps.userDataDir ?? app.getPath('userData');
  }

  /**
   * Create (or adopt) a vault via a folder dialog (Req 1.1–1.7).
   *
   * Shows a directory picker (with `createDirectory` so the user can make a new
   * folder inline). On confirm:
   * - If the chosen folder already carries a marker, it is *adopted* without
   *   overwriting its contents — no marker re-creation (Req 1.4).
   * - Otherwise the marker is written; a write failure returns
   *   `marker-create-failed` and leaves the active vault unchanged (Req 1.7).
   * On success the folder becomes the sole active vault and its path is
   * persisted to `userData/vault-state.json`.
   *
   * A cancelled dialog returns `{ ok: true, value: null }` — a cancel is not an
   * error (Req 1.6).
   */
  async create(): Promise<Result<VaultInfo | null>> {
    const dir = await this.pickDirectory(['openDirectory', 'createDirectory']);
    if (dir === null) {
      // Cancel is not an error; active vault unchanged (Req 1.6).
      return { ok: true, value: null };
    }

    // Adopt an existing vault without overwriting its contents (Req 1.4). Only
    // a folder that is not already a vault gets a fresh marker written.
    const recognition = await recognizeVault(dir);
    if (recognition !== 'vault') {
      const designated = await designateVault(dir);
      if (!designated.ok) {
        // Marker write failed: leave the active vault untouched (Req 1.7).
        return designated;
      }
    }

    return { ok: true, value: await this.activate(dir) };
  }

  /**
   * Open an existing vault via a folder dialog (Req 2.1–2.6).
   *
   * Shows a directory picker, then verifies the chosen folder carries a valid
   * marker before adopting it. Maps recognition failures onto the Error
   * Handling table:
   * - no marker → `not-a-vault` (Req 2.3)
   * - marker present but unreadable/malformed → `vault-unreadable` (Req 2.4)
   * In both cases the active vault is left unchanged. On success the folder
   * replaces any prior active vault (Req 2.2) and its path is persisted.
   *
   * A cancelled dialog returns `{ ok: true, value: null }` (Req 2.5).
   */
  async open(): Promise<Result<VaultInfo | null>> {
    const dir = await this.pickDirectory(['openDirectory']);
    if (dir === null) {
      // Cancel is not an error; active vault unchanged (Req 2.5).
      return { ok: true, value: null };
    }

    const recognition = await recognizeVault(dir);
    if (recognition !== 'vault') {
      // Leave the active vault unchanged and surface the specific error.
      return { ok: false, error: recognitionError(recognition, dir) };
    }

    return { ok: true, value: await this.activate(dir) };
  }

  /** The current active vault, or `null` when none is active (Req 2.6). */
  getActive(): VaultInfo | null {
    return this.active;
  }

  /**
   * Restore the last-active vault on boot (best-effort).
   *
   * Reads `userData/vault-state.json`; if it points at a path that still exists
   * and is still a valid vault, that vault becomes active and is returned.
   * Anything else — a missing state file, malformed JSON, a path that no longer
   * exists, or a folder that is no longer a vault — is silently ignored and
   * yields `null`, leaving no active vault. Restoration never surfaces an error
   * because a stale pointer is an expected, benign condition on boot.
   *
   * Note: this does *not* re-persist the state file (the pointer is already
   * correct on the happy path), so a successful restore leaves the file as-is.
   */
  async restore(): Promise<VaultInfo | null> {
    let raw: string;
    try {
      raw = await fs.readFile(this.stateFilePath(), 'utf8');
    } catch {
      // No state file (first run) or unreadable: nothing to restore.
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Corrupt pointer file: ignore rather than fail the boot.
      return null;
    }

    const lastVaultPath = readLastVaultPath(parsed);
    if (lastVaultPath === null) {
      return null;
    }

    // Ignore a stale pointer: the folder must still be a readable vault. This
    // also covers "path no longer exists" (recognizeVault → 'not-a-vault').
    if (!(await isVault(lastVaultPath))) {
      return null;
    }

    this.active = toVaultInfo(lastVaultPath);
    return this.active;
  }

  /**
   * Show the folder picker and return the chosen absolute path, or `null` for a
   * cancel (either the `canceled` flag or an empty `filePaths`, defensively).
   */
  private async pickDirectory(
    properties: NonNullable<OpenDialogOptions['properties']>,
  ): Promise<string | null> {
    const result = await this.showOpenDialog({ properties });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  }

  /**
   * Adopt `dir` as the sole active vault and persist the pointer. Shared tail
   * of the create/open happy paths so the "set active + persist" contract lives
   * in exactly one place. Returns the resulting {@link VaultInfo}.
   */
  private async activate(dir: string): Promise<VaultInfo> {
    this.active = toVaultInfo(dir);
    await this.persistActivePath(dir);
    return this.active;
  }

  /**
   * Persist the active vault path to `userData/vault-state.json`. Best-effort:
   * a failure to write the pointer must not fail an otherwise-successful
   * create/open (the vault *is* active in memory), so write errors are
   * swallowed — the only cost is that this particular activation won't be
   * restored on next boot.
   */
  private async persistActivePath(vaultPath: string): Promise<void> {
    const state: VaultState = { lastVaultPath: vaultPath };
    try {
      await fs.writeFile(
        this.stateFilePath(),
        `${JSON.stringify(state, null, 2)}\n`,
        'utf8',
      );
    } catch {
      // Non-fatal: see doc comment. The vault stays active for this session.
    }
  }

  /** Absolute path to the last-active-vault pointer file. */
  private stateFilePath(): string {
    return path.join(this.userDataDir, VAULT_STATE_FILE);
  }
}

/**
 * Build a {@link VaultInfo} from a vault folder path: `name` is the folder's
 * basename, shown as the vault name (design → Shared types).
 */
function toVaultInfo(vaultPath: string): VaultInfo {
  return { path: vaultPath, name: path.basename(vaultPath) };
}

/**
 * Map a non-`'vault'` {@link VaultRecognition} onto the {@link VaultError} the
 * open flow must report (design → Error Handling table): a missing marker is a
 * `not-a-vault` (the user picked an ordinary folder), while a present-but-broken
 * marker is a `vault-unreadable` (a real vault we cannot currently open).
 */
function recognitionError(
  recognition: Exclude<VaultRecognition, 'vault'>,
  dir: string,
): VaultError {
  if (recognition === 'not-a-vault') {
    return {
      code: 'not-a-vault',
      message: `'${dir}' is not a Marginalia vault.`,
    };
  }
  return {
    code: 'vault-unreadable',
    message: `'${dir}' has a vault marker that could not be read.`,
  };
}

/**
 * Best-effort extraction of `lastVaultPath` from parsed state JSON. Returns the
 * path only when it is a non-empty string; anything else (missing key, wrong
 * type, empty string) yields `null` so {@link VaultManager.restore} ignores it.
 */
function readLastVaultPath(parsed: unknown): string | null {
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    typeof (parsed as { lastVaultPath?: unknown }).lastVaultPath === 'string'
  ) {
    const value = (parsed as { lastVaultPath: string }).lastVaultPath;
    return value.length > 0 ? value : null;
  }
  return null;
}
