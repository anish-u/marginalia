import { app, Menu } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';

import { createNoteWindow } from '@main/windows';

const isMac = process.platform === 'darwin';

/**
 * Builds and installs the application menu.
 *
 * The template follows Electron's recommended structure: a macOS-only app menu
 * comes first, then File/Edit/View/Window built from `role` presets so the OS
 * wires up the standard shortcuts and behaviours for us. App-specific items
 * (like "New Note") sit in the File menu.
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
      submenu: [
        {
          label: 'New Note',
          accelerator: 'CmdOrCtrl+N',
          click: () => createNoteWindow(),
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
};
