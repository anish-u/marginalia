import { watch, type FSWatcher } from 'node:fs';
import { mkdirSync } from 'node:fs';
import * as path from 'node:path';

import { NOTES_DIR } from './note-store';

/**
 * Watches the active vault's `notes/` directory and fires a callback when its
 * contents change on disk — including changes made *outside* the app (e.g. a
 * user deleting a note file from Finder). Without this, the launcher's list
 * only refreshed on in-app mutations (the `NotesChanged` IPC broadcast), so
 * external deletes/edits left a stale list.
 *
 * Design notes:
 * - Non-recursive `fs.watch` on the single `notes/` dir. Recursive watching is
 *   unreliable/unsupported across platforms, and notes are a flat set of files
 *   there, so a shallow watch is sufficient.
 * - `fs.watch` is famously noisy (multiple events per operation, and event
 *   filenames are unreliable on macOS), so we ignore the event payload entirely
 *   and just debounce a "something changed, re-list" signal.
 * - The watcher is re-pointed whenever the active vault changes (call
 *   {@link watchNotesDir} with the new vault path, or `null` to stop). A single
 *   process-wide watcher is kept — there is only ever one active vault.
 */

/** The current watcher, or null when nothing is being watched. */
let current: FSWatcher | null = null;
/** The directory the current watcher is bound to (for idempotent re-pointing). */
let currentDir: string | null = null;
/** Pending debounce timer, so a burst of fs events fires the callback once. */
let debounceTimer: NodeJS.Timeout | null = null;

/** Registered change callback (set once by the owner, e.g. ipc/notes.ts). */
let onChange: (() => void) | null = null;

/**
 * Timestamp (ms, `Date.now()`) until which fs.watch events are ignored because
 * the app itself just wrote to the notes dir. Zero means "not suppressing".
 * See {@link markAppWrite} for why this exists.
 */
let quietUntil = 0;

/** Coalesce fs.watch's event storms into a single delayed notification. */
const DEBOUNCE_MS = 150;

/**
 * How long an app write silences the watcher. `fs.watch` reports the app's own
 * writes just like external ones, so without this every in-app save would fire
 * twice: once via the explicit `NotesChanged` broadcast from the write handler,
 * and once as a watcher echo (Req 3.1, 3.2). The window must comfortably span
 * the raw event storm a single write produces (fs.watch emits several events
 * per operation) plus the atomic write's rename step, so we make it a little
 * longer than the debounce interval. It only needs to be long enough to absorb
 * the app's own events, not so long that a genuinely external change arriving
 * right after an app write gets swallowed for an unreasonable time.
 */
const APP_WRITE_QUIET_MS = DEBOUNCE_MS + 100;

/**
 * Register the callback fired (debounced) whenever the watched notes directory
 * changes. Call once during setup; subsequent calls replace the callback.
 */
export function setNotesChangeHandler(handler: () => void): void {
  onChange = handler;
}

/**
 * Open (or extend) the "app-write quiet window": for a short interval after
 * this call, fs.watch events are ignored so the watcher does not echo a change
 * the app just made itself. Call this immediately around an in-app note
 * write/delete/rename — the explicit `NotesChanged` broadcast from that handler
 * is the single source of truth for in-app changes, and this suppression stops
 * the watcher from emitting a redundant second event for the same action
 * (Req 3.1, 3.2).
 *
 * It intentionally does not touch the debounce timer: genuinely external
 * changes (with no recent `markAppWrite`) still coalesce and fire one
 * payload-less notification as before (Req 3.4, 3.5). "Extend" rather than
 * "set" so a burst of app writes keeps the window open through the last one.
 */
export function markAppWrite(): void {
  quietUntil = Date.now() + APP_WRITE_QUIET_MS;
}

function scheduleNotify(): void {
  // Inside the app-write quiet window this event is (almost certainly) the echo
  // of the app's own write, already covered by the explicit broadcast — drop it
  // and do not arm the debounce, so no redundant notification fires (Req 3.2).
  if (Date.now() < quietUntil) return;

  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    onChange?.();
  }, DEBOUNCE_MS);
}

/**
 * Point the watcher at a vault's `notes/` directory, replacing any previous
 * watch. Pass `null` to stop watching (e.g. when the active vault is cleared).
 *
 * Idempotent: re-pointing at the directory already being watched is a no-op, so
 * this is safe to call on every `VaultChanged` broadcast.
 */
export function watchNotesDir(vaultPath: string | null): void {
  const notesDir = vaultPath ? path.join(vaultPath, NOTES_DIR) : null;

  // Already watching the right place — nothing to do.
  if (notesDir === currentDir) return;

  // Tear down the previous watcher.
  if (current) {
    current.close();
    current = null;
    currentDir = null;
  }

  if (!notesDir) return;

  // Ensure the directory exists before watching — a fresh vault has no notes/
  // folder yet, and `fs.watch` throws on a missing path. Creating it is
  // harmless (the store also creates it on first write) and lets us catch the
  // very first externally-added file.
  try {
    mkdirSync(notesDir, { recursive: true });
    current = watch(notesDir, { persistent: false }, () => scheduleNotify());
    currentDir = notesDir;
    // A watcher error (e.g. the dir is removed) shouldn't crash the process;
    // drop the watch and wait for the next vault change to re-establish it.
    current.on('error', () => {
      current?.close();
      current = null;
      currentDir = null;
    });
  } catch {
    // Couldn't watch (permissions, transient FS state) — non-fatal. In-app
    // mutations still broadcast NotesChanged directly, and focus-refresh covers
    // the gap; the watcher is a best-effort convenience.
    current = null;
    currentDir = null;
  }
}
