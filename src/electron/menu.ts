import { app, Menu } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';

const isMac = process.platform === 'darwin';

/**
 * Builds and installs the application menu.
 *
 * The template follows Electron's recommended structure: a macOS-only app menu
 * comes first, then File/Edit/View/Window built from `role` presets so the OS
 * wires up the standard shortcuts and behaviours for us. App-specific items can
 * sit in the File menu as the app grows.
 *
 * Call this once after `app` is ready.
 */
export const installApplicationMenu = (): void => {
  const template: MenuItemConstructorOptions[] = [
    // { App menu } — macOS only.
    ...(isMac
      ? ([
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ] as MenuItemConstructorOptions[])
      : []),
    {
      label: 'File',
      submenu: [isMac ? { role: 'close' } : { role: 'quit' }],
    },
    {
      // Edit menu — built entirely from Electron `role` presets. This is what
      // wires the standard clipboard/undo shortcuts (⌘C/⌘V/⌘X/⌘A/⌘Z/⇧⌘Z) to the
      // focused webContents. Without an Edit menu carrying these roles, macOS
      // never delivers those accelerators, which is why copy/paste appeared
      // "broken". The roles also cover the `<webview>` guest page's selection.
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        ...(isMac
          ? ([
              { role: 'pasteAndMatchStyle' },
              { role: 'delete' },
              { role: 'selectAll' },
              { type: 'separator' },
              {
                label: 'Speech',
                submenu: [{ role: 'startSpeaking' }, { role: 'stopSpeaking' }],
              },
            ] as MenuItemConstructorOptions[])
          : ([
              { role: 'delete' },
              { type: 'separator' },
              { role: 'selectAll' },
            ] as MenuItemConstructorOptions[])),
      ],
    },
    {
      // View menu — reload/devtools/zoom/fullscreen from role presets. Handy for
      // development and expected by users; all standard behaviours.
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      // Window menu — minimize/zoom/close, with the macOS front/window extras.
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac
          ? ([
              { type: 'separator' },
              { role: 'front' },
            ] as MenuItemConstructorOptions[])
          : ([{ role: 'close' }] as MenuItemConstructorOptions[])),
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
};
