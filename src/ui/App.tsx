import { FC, useEffect } from 'react';

import { HashRouter, Route, Routes } from 'react-router';

import { MainView } from '@ui/views/MainView';
import { ResourceNoteView } from '@ui/views/ResourceNoteView';
import { subscribeToThemeChanges } from '@ui/lib/theme';


/**
 * Top-level router.
 *
 * All windows load the same renderer bundle; the main process picks which view
 * to show by loading a different URL hash (`#/` for the launcher,
 * `#/resource-note` for resource-note windows — see `src/electron/windows`).
 *
 * We use `HashRouter` rather than `BrowserRouter` because Electron serves the
 * renderer from a `file://`/dev-server URL where path-based history routing
 * breaks on reload. Hash routing keeps navigation entirely client-side.
 */
export const App: FC = () => {
  // Every window subscribes to theme broadcasts so a change made in the
  // launcher (or any window) is reflected everywhere. `subscribeToThemeChanges`
  // applies the `.dark` class itself; MainView additionally keeps its toggle in
  // sync via its own subscription. Applying the class is idempotent.
  useEffect(() => subscribeToThemeChanges(() => {}), []);

  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<MainView />} />
        <Route path="/resource-note" element={<ResourceNoteView />} />
      </Routes>
    </HashRouter>
  );
};
