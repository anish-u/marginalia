import { useState, type FC } from 'react';

import { FolderOpen, FolderPlus } from 'lucide-react';

import { Button } from '@/components/ui/button';

/**
 * The launcher state shown when there is no active vault (Req 3.2).
 *
 * Notes live in a vault (a user-chosen folder), so before anything can be
 * listed the user has to either create a new vault or open an existing one.
 * Both actions delegate to the main process through the preload bridge — the
 * folder picker itself is a native dialog owned by the main process, so this
 * component only sends the intent and reacts to the returned {@link Result}.
 *
 * A cancelled picker resolves with `value: null` and is intentionally *not* an
 * error (Req 1.6, 2.5), so we simply do nothing in that case. Genuine failures
 * (e.g. `marker-create-failed`, `not-a-vault`, `vault-unreadable`) come back as
 * data and are surfaced inline rather than thrown.
 *
 * Kept deliberately minimal and centered, in keeping with the app's
 * distraction-free posture. `onVaultOpened` lets the host (MainView) refresh
 * once a vault becomes active, though the main process also broadcasts the
 * change over `onVaultChanged`.
 */
export const VaultEmptyState: FC<{
  /** Optional hook fired after a vault is successfully created/opened. */
  onVaultOpened?: () => void;
}> = ({ onVaultOpened }) => {
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
      // `value === null` means the user cancelled the picker — leave state as
      // is and show no error (Req 1.6, 2.5).
      if (result.value) onVaultOpened?.();
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col items-center gap-6 text-center">
      <div className="flex flex-col items-center gap-2">
        <h1 className="text-3xl font-bold tracking-tight">Marginalia</h1>
        <p className="text-muted-foreground">
          Capture a thought in its own window.
        </p>
      </div>

      <p className="max-w-sm text-sm text-muted-foreground">
        Open a vault to see your notes, or create a new one to get started.
      </p>

      <div className="flex flex-col items-center gap-3 sm:flex-row">
        <Button
          size="lg"
          disabled={busy}
          onClick={() => run(() => window.marginalia.createVault())}
        >
          <FolderPlus className="size-4" />
          Create Vault
        </Button>
        <Button
          size="lg"
          variant="outline"
          disabled={busy}
          onClick={() => run(() => window.marginalia.openVault())}
        >
          <FolderOpen className="size-4" />
          Open Vault
        </Button>
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
};
