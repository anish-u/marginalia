import { HashRouter, Route, Routes } from 'react-router';

import { MainView } from '@ui/views/MainView';
import { NoteView } from '@ui/views/NoteView';
import { FC } from 'react';

/**
 * Top-level router.
 *
 * All windows load the same renderer bundle; the main process picks which view
 * to show by loading a different URL hash (`#/` for the launcher, `#/note` for
 * note windows — see `src/electron/windows`).
 *
 * We use `HashRouter` rather than `BrowserRouter` because Electron serves the
 * renderer from a `file://`/dev-server URL where path-based history routing
 * breaks on reload. Hash routing keeps navigation entirely client-side.
 */
export const App: FC = () => (
  <HashRouter>
    <Routes>
      <Route path="/" element={<MainView />} />
      <Route path="/note" element={<NoteView />} />
    </Routes>
  </HashRouter>
);
