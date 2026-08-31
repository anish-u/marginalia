import { app, BrowserWindow } from 'electron';

/**
 * Creates a resource-note window: a split view with a browser pane on one side
 * and a note editor on the other.
 *
 * Like note windows, it reuses the main renderer bundle and selects its UI via
 * a route hash (`#/resource-note`). What the renderer should show is passed
 * along as query params on that hash:
 *
 * - `url`    — the resource URL to load in the browser pane (a fresh note).
 * - `noteId` — the id of an existing note to load from the active vault; the
 *              renderer will `readNote(id)` to recover the resource url and
 *              prose, so `url` may be omitted when opening by id.
 * - `title`  — an optional initial title for a fresh note, chosen by the user
 *              in the launcher's "New Resource Note" dialog. Ignored when
 *              opening an existing note (its title comes from the loaded note).
 *
 * Both `url`/`title` and `noteId` can coexist, but in practice a fresh note
 * carries `url` (+ optional `title`) while an existing note carries `noteId`.
 * When none is provided the renderer falls back to its default. Params are
 * URL-encoded via `URLSearchParams` so values with reserved characters survive
 * the round-trip.
 *
 * The browser pane itself is an Electron `<webview>`, which runs out-of-process
 * and is therefore not subject to the renderer's strict CSP — that's why
 * `webviewTag` is enabled here.
 */
export const createResourceNoteWindow = (
  url?: string,
  noteId?: string,
  title?: string,
): BrowserWindow => {
  const resourceNoteWindow = new BrowserWindow({
    height: 700,
    width: 1100,
    title: 'Resource Note',
    webPreferences: {
      preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
      contextIsolation: true,
      nodeIntegration: false,
      // Allow the <webview> tag so the browser pane can load an external site
      // in its own process, outside the renderer's Content-Security-Policy.
      webviewTag: true,
    },
  });

  const params = new URLSearchParams();
  if (noteId) params.set('noteId', noteId);
  if (url) params.set('url', url);
  // Only meaningful for a fresh note (no noteId); an existing note gets its
  // title from the loaded file, so skip it there to avoid a misleading param.
  if (title && !noteId) params.set('title', title);
  const query = params.toString();
  const target = query ? `?${query}` : '';
  resourceNoteWindow.loadURL(
    `${MAIN_WINDOW_WEBPACK_ENTRY}#/resource-note${target}`,
  );

  if (!app.isPackaged) {
    resourceNoteWindow.webContents.openDevTools();
  }

  return resourceNoteWindow;
};
