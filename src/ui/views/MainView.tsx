import { FC, useCallback, useEffect, useState } from 'react';

import { Moon, Plus, Settings, Sun } from 'lucide-react';

import { NewResourceNoteDialog } from '@/components/notes/NewResourceNoteDialog';
import { NotesListView } from '@/components/notes/NotesListView';
import { SettingsDialog } from '@/components/notes/SettingsDialog';
import { VaultEmptyState } from '@/components/notes/VaultEmptyState';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  getStoredTheme,
  setTheme,
  subscribeToThemeChanges,
  type Theme,
} from '@ui/lib/theme';
import type { VaultInfo } from '@shared/resource-note';

/**
 * The launcher shown in the main window.
 *
 * Two jobs, gated on whether a vault is active:
 *
 *  - **No active vault** → render {@link VaultEmptyState}, whose create/open
 *    actions designate a vault (Req 3.2).
 *  - **Active vault** → render {@link NotesListView} for that vault (Req 3.1),
 *    wrapped in a header (vault name + "New Resource Note") and a footer
 *    (version).
 *
 * The active vault is fetched once on mount via `getActiveVault()` and then
 * kept live by subscribing to `onVaultChanged` (Req 2.6, 3.3). Because the
 * main process broadcasts the change to every window, opening/creating a vault
 * in *any* window flips this view within the 1s budget.
 *
 * `NotesListView` re-fetches whenever its `vault` prop *identity* changes, so
 * we always hand it the exact `VaultInfo` object we're holding in state — each
 * vault change produces a new object, which forces the list to refresh and
 * (via the remount-free re-render) clears any prior selection/errors (Req 3.3).
 *
 * App metadata (version) and the theme toggle live here too; flipping the
 * toggle persists the choice and (via the main-process fan-out) keeps other
 * open windows in sync.
 */
export const MainView: FC = () => {
  const [version, setVersion] = useState<string>('…');
  const [theme, setThemeState] = useState<Theme>(() => getStoredTheme());
  // `undefined` = not yet loaded (avoids flashing the empty state before the
  // initial `getActiveVault()` resolves); `null` = loaded, no active vault.
  const [activeVault, setActiveVault] = useState<VaultInfo | null | undefined>(
    undefined,
  );
  // Whether the "New Resource Note" dialog is open.
  const [newNoteOpen, setNewNoteOpen] = useState(false);
  // Whether the Settings dialog is open.
  const [settingsOpen, setSettingsOpen] = useState(false);

  const refreshActiveVault = useCallback(async () => {
    try {
      const vault = await window.marginalia.getActiveVault();
      setActiveVault(vault);
    } catch {
      setActiveVault(null);
    }
  }, []);

  useEffect(() => {
    window.marginalia
      .getAppVersion()
      .then(setVersion)
      .catch(() => setVersion('unknown'));
  }, []);

  // Load the initial active vault on mount.
  useEffect(() => {
    void refreshActiveVault();
  }, [refreshActiveVault]);

  // Stay in sync with vault changes broadcast from the main process (Req 3.3).
  // The callback receives the new VaultInfo (or null); storing it swaps the
  // view and, because it's a fresh object, retriggers the list's re-fetch.
  useEffect(
    () => window.marginalia.onVaultChanged((vault) => setActiveVault(vault)),
    [],
  );

  // Reflect theme changes made in other windows back into this toggle.
  useEffect(() => subscribeToThemeChanges(setThemeState), []);

  const isDark = theme === 'dark';
  const toggleTheme = (checked: boolean) => {
    const next: Theme = checked ? 'dark' : 'light';
    setTheme(next);
    setThemeState(next);
  };

  const themeToggle = (
    <label className="flex items-center gap-2 text-muted-foreground">
      {isDark ? <Moon className="size-4" /> : <Sun className="size-4" />}
      <Switch
        checked={isDark}
        onCheckedChange={toggleTheme}
        aria-label="Toggle dark mode"
      />
    </label>
  );

  const settingsButton = (
    <Button
      size="icon"
      variant="ghost"
      onClick={() => setSettingsOpen(true)}
      aria-label="Settings"
      title="Settings"
    >
      <Settings className="size-4" />
    </Button>
  );

  // The settings dialog is available in every state, so render it once here and
  // reuse it across the branches below. `activeVault` may be undefined (still
  // loading) — treat that as "no active vault" for display.
  const settingsDialog = (
    <SettingsDialog
      open={settingsOpen}
      onClose={() => setSettingsOpen(false)}
      activeVault={activeVault ?? null}
    />
  );

  // Before the first `getActiveVault()` resolves, render nothing but the theme
  // toggle so we don't flash the empty state and then the list.
  if (activeVault === undefined) {
    return (
      <main className="relative flex min-h-screen flex-col p-8">
        <div className="absolute top-4 right-4 flex items-center gap-2">
          {settingsButton}
          {themeToggle}
        </div>
        {settingsDialog}
      </main>
    );
  }

  // No active vault → the empty state owns the whole window (Req 3.2).
  if (activeVault === null) {
    return (
      <main className="relative flex min-h-screen flex-col items-center justify-center gap-6 p-8">
        <div className="absolute top-4 right-4 flex items-center gap-2">
          {settingsButton}
          {themeToggle}
        </div>
        <VaultEmptyState onVaultOpened={() => void refreshActiveVault()} />
        <p className="text-xs text-muted-foreground">Version {version}</p>
        {settingsDialog}
      </main>
    );
  }

  // Active vault → notes list, framed by a header and footer (Req 3.1).
  return (
    <main className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between gap-4 border-b px-5 py-3">
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold tracking-tight">
            {activeVault.name}
          </h1>
          <p className="truncate text-xs text-muted-foreground">
            {activeVault.path}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <Button size="sm" onClick={() => setNewNoteOpen(true)}>
            <Plus className="size-4" />
            New Resource Note
          </Button>
          {settingsButton}
          {themeToggle}
        </div>
      </header>

      <div className="flex flex-1 flex-col items-center py-6">
        <NotesListView vault={activeVault} />
      </div>

      <footer className="border-t px-5 py-2 text-center text-xs text-muted-foreground">
        Version {version}
      </footer>

      <NewResourceNoteDialog
        open={newNoteOpen}
        onClose={() => setNewNoteOpen(false)}
        onCreate={(url, title) => {
          // Window creation lives in the main process; the renderer only sends
          // the chosen url + title. The new note window seeds its title from
          // `title` and loads `url` in the browser pane.
          void window.marginalia.openResourceNoteWindow(url, title);
          setNewNoteOpen(false);
        }}
      />
      {settingsDialog}
    </main>
  );
};
