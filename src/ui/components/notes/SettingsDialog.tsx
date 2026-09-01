import { useState, type FC } from 'react';

import { FolderOpen, FolderPlus } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { VaultInfo } from '@shared/resource-note';

/**
 * Settings dialog for managing the active vault at any time.
 *
 * Previously a vault could only be created/opened from the empty state (before
 * any vault existed). This surfaces the same create/open actions whenever the
 * user wants them, plus shows which vault is currently active. Switching vaults
 * is just calling `createVault()`/`openVault()` again — the main process
 * broadcasts `VaultChanged`, so the launcher list refreshes automatically and
 * this dialog closes.
 *
 * A cancelled picker resolves with `value: null` (not an error), so we do
 * nothing in that case. Genuine failures come back as data and show inline.
 */
export const SettingsDialog: FC<{
  open: boolean;
  onClose: () => void;
  /** The currently active vault (shown for context), or null if none. */
  activeVault: VaultInfo | null;
}> = ({ open, onClose, activeVault }) => {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (
    action: () => ReturnType<
      typeof window.marginalia.createVault | typeof window.marginalia.openVault
    >,
  ) => {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      // value === null ⇒ the user cancelled the picker; leave things as they
      // are. A real switch broadcasts VaultChanged; close so the refreshed
      // launcher is visible.
      if (result.value) onClose();
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    setError(null);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-5">
        <section className="flex flex-col gap-1.5">
          <h3 className="text-sm font-medium">Active vault</h3>
          {activeVault ? (
            <div className="rounded-md border bg-muted/40 px-3 py-2">
              <p className="truncate text-sm font-medium">{activeVault.name}</p>
              <p className="truncate text-xs text-muted-foreground">
                {activeVault.path}
              </p>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No vault is active.</p>
          )}
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">Change vault</h3>
          <p className="text-sm text-muted-foreground">
            Open a different vault or create a new one. Your current notes stay
            where they are.
          </p>
          <div className="mt-1 flex flex-col gap-2 sm:flex-row">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void run(() => window.marginalia.openVault())}
            >
              <FolderOpen className="size-4" />
              Open Vault…
            </Button>
            <Button
              disabled={busy}
              onClick={() => void run(() => window.marginalia.createVault())}
            >
              <FolderPlus className="size-4" />
              Create Vault…
            </Button>
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </section>

          <div className="flex justify-end">
            <Button variant="ghost" onClick={close}>
              Done
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
