import { FC, useEffect, useState } from 'react';

import { Moon, Sun } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  getStoredTheme,
  setTheme,
  subscribeToThemeChanges,
  type Theme,
} from '@ui/lib/theme';

/**
 * The launcher shown in the main window.
 *
 * Its job is to open resource-note windows. The "New Resource Note" button asks
 * the main process (via the preload bridge) to spawn a fresh resource-note
 * window; each click opens a new one. App metadata like the version lives here
 * too, alongside the theme toggle — flipping it persists the choice and (via
 * the storage event) keeps any other open windows in sync.
 */
export const MainView: FC = () => {
  const [version, setVersion] = useState<string>('…');
  const [theme, setThemeState] = useState<Theme>(() => getStoredTheme());

  useEffect(() => {
    window.marginalia
      .getAppVersion()
      .then(setVersion)
      .catch(() => setVersion('unknown'));
  }, []);

  // Reflect theme changes made in other windows back into this toggle.
  useEffect(() => subscribeToThemeChanges(setThemeState), []);

  const isDark = theme === 'dark';
  const toggleTheme = (checked: boolean) => {
    const next: Theme = checked ? 'dark' : 'light';
    setTheme(next);
    setThemeState(next);
  };

  return (
    <main className="relative flex min-h-screen flex-col items-center justify-center gap-6 p-8">
      {/* Theme toggle, tucked in the corner so it stays out of the way. */}
      <label className="absolute top-4 right-4 flex items-center gap-2 text-muted-foreground">
        {isDark ? (
          <Moon className="size-4" />
        ) : (
          <Sun className="size-4" />
        )}
        <Switch
          checked={isDark}
          onCheckedChange={toggleTheme}
          aria-label="Toggle dark mode"
        />
      </label>

      <div className="flex flex-col items-center gap-2 text-center">
        <h1 className="text-3xl font-bold tracking-tight">Marginalia</h1>
        <p className="text-muted-foreground">
          Capture a thought in its own window.
        </p>
      </div>

      <div className="flex flex-col items-center gap-3">
        <Button
          size="lg"
          onClick={() =>
            window.marginalia.openResourceNoteWindow('https://en.wikipedia.org/wiki/1886_Charleston_earthquake')
          }
        >
          New Resource Note
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">Version {version}</p>
    </main>
  );
};
