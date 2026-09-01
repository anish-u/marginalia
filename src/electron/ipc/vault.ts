import { BrowserWindow, ipcMain } from 'electron';

import { IpcChannels } from '@main/ipc-channels';
import { VaultManager } from '@main/vault/vault-manager';
import { watchNotesDir } from '@main/vault/notes-watcher';

import type { Result, VaultInfo } from '@shared/resource-note';

/**
 * The single, process-wide {@link VaultManager} instance.
 *
 * The active vault is app-global state: whichever vault the user last created,
 * opened, or restored is the one *every* window reads and writes against. To
 * keep that consistent, the whole main process must share one manager — the
 * notes IPC handlers (task 7.4) resolve the active vault path through it, and
 * the boot sequence (task 7.7, `index.ts`) calls `restore()` on it. So this
 * module owns the instance and exports it as a singleton for those callers to
 * import.
 *
 * Other main-process modules MUST import this exact binding
 * (`import { vaultManager } from '@main/ipc/vault'`) rather than constructing
 * their own `new VaultManager()`, which would have its own independent active
 * vault and silently diverge.
 */
export const vaultManager = new VaultManager();

/**
 * Fan a `VaultChanged` broadcast out to *every* open window.
 *
 * This mirrors the theme fan-out in `ipc/theme.ts` (the cross-window `storage`
 * event is unreliable between separate Electron BrowserWindows, so we route
 * through the main process), with one deliberate difference: theme skips the
 * sender because it already applied the change locally, but the active vault is
 * app-global — the launcher that triggered the create/open must *also* refresh
 * its notes list, and any other open window must react too. So here we send to
 * all windows, including the sender.
 */
function broadcastVaultChanged(vault: VaultInfo | null): void {
  // Re-point the on-disk notes watcher at the new vault (or stop it when the
  // vault is cleared) so external file changes in the now-active vault refresh
  // every list. Idempotent, so calling it on each change is safe.
  watchNotesDir(vault?.path ?? null);
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IpcChannels.VaultChanged, vault);
  }
}

/**
 * Registers IPC handlers for vault lifecycle (`vault:*` channels), delegating
 * to the shared {@link vaultManager}.
 *
 * `VaultCreate`/`VaultOpen` run the manager's dialog flow and, on a *successful
 * active-vault change*, broadcast the new {@link VaultInfo} to every window so
 * their notes lists refresh (Req 2.6, 3.3). A cancelled dialog resolves with
 * `{ ok: true, value: null }` — no active-vault change happened, so no
 * broadcast is sent (Req 1.6, 2.5). Errors (`marker-create-failed`,
 * `not-a-vault`, `vault-unreadable`) are returned as data and likewise leave
 * the active vault, and every window, untouched (Req 1.7, 2.3, 2.4).
 *
 * `VaultGetActive` is a pure read of the current active vault for boot/display.
 */
export const registerVaultHandlers = (): void => {
  ipcMain.handle(
    IpcChannels.VaultCreate,
    async (): Promise<Result<VaultInfo | null>> => {
      const result = await vaultManager.create();
      broadcastIfActivated(result);
      return result;
    },
  );

  ipcMain.handle(
    IpcChannels.VaultOpen,
    async (): Promise<Result<VaultInfo | null>> => {
      const result = await vaultManager.open();
      broadcastIfActivated(result);
      return result;
    },
  );

  ipcMain.handle(
    IpcChannels.VaultGetActive,
    (): VaultInfo | null => vaultManager.getActive(),
  );
};

/**
 * Broadcast `VaultChanged` only when a create/open actually changed the active
 * vault — i.e. it succeeded *and* returned a non-null {@link VaultInfo}. A
 * cancel (`{ ok: true, value: null }`) or an error left the active vault
 * unchanged, so no window needs to be notified.
 */
function broadcastIfActivated(result: Result<VaultInfo | null>): void {
  if (result.ok && result.value !== null) {
    broadcastVaultChanged(result.value);
  }
}
