import { FC, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';

/**
 * The launcher shown in the main window.
 *
 * Its job is to open note windows. The "New Note" button asks the main process
 * (via the preload bridge) to spawn a fresh note window; each click opens a new
 * one. App metadata like the version lives here too.
 */
export const MainView: FC = () => {
  const [version, setVersion] = useState<string>('…');

  useEffect(() => {
    window.marginalia
      .getAppVersion()
      .then(setVersion)
      .catch(() => setVersion('unknown'));
  }, []);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-8">
      <div className="flex flex-col items-center gap-2 text-center">
        <h1 className="text-3xl font-bold tracking-tight">Marginalia</h1>
        <p className="text-muted-foreground">
          Capture a thought in its own window.
        </p>
      </div>

      <Button size="lg" onClick={() => window.marginalia.openNoteWindow()}>
        New Note
      </Button>

      <p className="text-xs text-muted-foreground">Version {version}</p>
    </main>
  );
};
