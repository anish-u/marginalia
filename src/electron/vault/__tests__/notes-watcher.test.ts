/**
 * Unit tests for the On_Disk_Watcher's "app-write quiet window" (task 2.3,
 * Req 3.1, 3.2, 3.4, 3.5).
 *
 * The watcher's job is to notify (debounced) when the vault's `notes/` dir
 * changes on disk — but NOT for changes the app itself just made, because those
 * already get an explicit `NotesChanged` broadcast from the write handler.
 * `markAppWrite()` opens a short quiet window during which observed fs.watch
 * events are dropped (Req 3.2); genuinely external events (no recent app write)
 * still coalesce into a single debounced notification (Req 3.4, 3.5).
 *
 * Testing approach (design → Testing Strategy: "watcher unit (node env)"):
 *  - `node:fs` is mocked so `watch()` doesn't touch a real filesystem and,
 *    crucially, so we can *capture the change listener* it is handed. The test
 *    then invokes that captured listener to simulate fs.watch firing — exactly
 *    what the real OS does when the notes dir changes — without any timing race.
 *  - `mkdirSync` is a no-op stub (the real watcher creates the dir before
 *    watching; there is no dir here).
 *  - Fake timers drive the debounce (`DEBOUNCE_MS = 150`) and the quiet-window
 *    expiry (`APP_WRITE_QUIET_MS = DEBOUNCE_MS + 100 = 250`) deterministically.
 *  - The watcher module keeps process-wide singleton state (the current watch,
 *    the debounce timer, and `quietUntil`), so each test re-imports it fresh via
 *    `vi.resetModules()` + dynamic `import()` to avoid state bleeding between
 *    cases. The mock factory is hoisted, so the captured-listener box is reset
 *    per test in `beforeEach`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A mutable box holding the change listener that the watcher passed to
 * `fs.watch`. Populated by the mocked `watch` below; read by `fireFsEvent()` to
 * simulate the OS reporting a change. Reset per test.
 */
const watchBox: { listener: (() => void) | null; closed: boolean } = {
  listener: null,
  closed: false,
};

// Partially mock node:fs: keep every real export (the watcher's sibling
// `note-store` module also imports from node:fs and needs `promises`, etc.) but
// override just the two the watcher uses. `watch` records the listener (and
// returns a minimal FSWatcher stub with the `.on('error')` / `.close()` surface
// the watcher uses); `mkdirSync` is a harmless no-op since there is no real dir.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    watch: (_dir: string, _opts: unknown, listener: () => void) => {
      watchBox.listener = listener;
      watchBox.closed = false;
      return {
        on: vi.fn(),
        close: vi.fn(() => {
          watchBox.closed = true;
        }),
      };
    },
    mkdirSync: vi.fn(),
  };
});

/**
 * Freshly import the watcher module so its singleton state (quietUntil,
 * debounce timer, current watch) starts clean for each test. Returns the
 * module's public surface.
 */
async function loadWatcher(): Promise<typeof import('@main/vault/notes-watcher')> {
  vi.resetModules();
  return import('@main/vault/notes-watcher');
}

/** Simulate the OS firing an fs.watch change event on the watched notes dir. */
function fireFsEvent(): void {
  if (!watchBox.listener) throw new Error('fs.watch listener was never registered');
  watchBox.listener();
}

beforeEach(() => {
  watchBox.listener = null;
  watchBox.closed = false;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('notes-watcher — app-write quiet window (Req 3.1, 3.2, 3.4, 3.5)', () => {
  it('notifies once (debounced) for an external change with no recent app write', async () => {
    const { setNotesChangeHandler, watchNotesDir } = await loadWatcher();
    const onChange = vi.fn();
    setNotesChangeHandler(onChange);
    watchNotesDir('/vault');

    // An external change arrives (no markAppWrite): it should notify, once,
    // after the debounce interval.
    fireFsEvent();
    expect(onChange).not.toHaveBeenCalled(); // debounced, not yet fired
    vi.advanceTimersByTime(150); // DEBOUNCE_MS
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('coalesces a burst of external events into a single notification', async () => {
    const { setNotesChangeHandler, watchNotesDir } = await loadWatcher();
    const onChange = vi.fn();
    setNotesChangeHandler(onChange);
    watchNotesDir('/vault');

    // fs.watch is noisy: several raw events per operation. They must coalesce.
    fireFsEvent();
    vi.advanceTimersByTime(50);
    fireFsEvent();
    vi.advanceTimersByTime(50);
    fireFsEvent();
    // Still within the debounce of the last event → nothing yet.
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(150);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('suppresses events that arrive within the quiet window after markAppWrite', async () => {
    const { markAppWrite, setNotesChangeHandler, watchNotesDir } =
      await loadWatcher();
    const onChange = vi.fn();
    setNotesChangeHandler(onChange);
    watchNotesDir('/vault');

    // The app just wrote: open the quiet window, then the fs.watch storm from
    // that write arrives. Every such event must be dropped — not even armed on
    // the debounce — so no notification ever fires (the explicit broadcast is
    // the single source of truth for this action).
    markAppWrite();
    fireFsEvent();
    fireFsEvent();
    // Advance well past the debounce: still nothing, because the events were
    // dropped rather than debounced.
    vi.advanceTimersByTime(150);
    expect(onChange).not.toHaveBeenCalled();

    // Even after the debounce interval fully elapses (but still inside the
    // 250ms quiet window), no stray notification appears.
    vi.advanceTimersByTime(50); // total 200ms < 250ms
    expect(onChange).not.toHaveBeenCalled();
  });

  it('resumes notifying for events once the quiet window has expired', async () => {
    const { markAppWrite, setNotesChangeHandler, watchNotesDir } =
      await loadWatcher();
    const onChange = vi.fn();
    setNotesChangeHandler(onChange);
    watchNotesDir('/vault');

    // App writes, its own event is suppressed…
    markAppWrite();
    fireFsEvent();
    vi.advanceTimersByTime(150);
    expect(onChange).not.toHaveBeenCalled();

    // …then the quiet window (APP_WRITE_QUIET_MS = 250ms) expires. Advance past
    // it, and a subsequent (genuinely external) event notifies again, once.
    vi.advanceTimersByTime(150); // total 300ms > 250ms quiet window
    fireFsEvent();
    expect(onChange).not.toHaveBeenCalled(); // debounced
    vi.advanceTimersByTime(150);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('does not swallow an external change that arrives just after the quiet window', async () => {
    const { markAppWrite, setNotesChangeHandler, watchNotesDir } =
      await loadWatcher();
    const onChange = vi.fn();
    setNotesChangeHandler(onChange);
    watchNotesDir('/vault');

    // App write opens the quiet window at t=0 (expires at t=250).
    markAppWrite();
    // A genuinely external change lands at t=260, just after the window closed.
    vi.advanceTimersByTime(260);
    fireFsEvent();
    vi.advanceTimersByTime(150);
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
