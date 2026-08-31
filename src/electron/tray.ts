import { app, BrowserWindow, Menu, nativeImage, Tray } from 'electron';
import type { NativeImage } from 'electron';

import { createMainWindow } from '@main/windows';

let tray: Tray | null = null;

/**
 * A 16x16 rounded-square glyph, embedded as a base64 PNG.
 *
 * PNG is used (not SVG) because Electron's `nativeImage` does not rasterize
 * SVG data URLs. Marked as a template image on macOS so the OS paints it to
 * match light/dark menu bars. Swap in a branded asset later with
 * `nativeImage.createFromPath(...)`.
 */
const TRAY_ICON_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAK0lEQVR4nGNgGKzgPw5M' +
  'tkaiDaLIAGI14zRk1AAqGECKITgBxQYQMmgQAgA9kHuFzUoN1gAAAABJRU5ErkJggg==';

const buildTrayIcon = (): NativeImage => {
  const image = nativeImage.createFromDataURL(
    `data:image/png;base64,${TRAY_ICON_PNG_BASE64}`,
  );
  image.setTemplateImage(true);
  return image;
};

/** Focuses an existing main window or creates one if none exist. */
const showMainWindow = (): void => {
  const [existing] = BrowserWindow.getAllWindows();
  if (existing) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
    return;
  }
  createMainWindow();
};

/**
 * Creates the system tray icon and its context menu.
 *
 * Keeps a module-level reference so the Tray isn't garbage collected (a common
 * cause of the icon disappearing). Call once after `app` is ready.
 */
export const createTray = (): Tray => {
  if (tray) return tray;

  const icon = buildTrayIcon();
  tray = new Tray(icon);
  tray.setToolTip('Marginalia');

  // If the icon somehow renders empty, a short title keeps the tray visible in
  // the menu bar (macOS shows this text next to the icon).
  if (icon.isEmpty()) {
    tray.setTitle('Marginalia');
  }

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show Window',
      click: () => showMainWindow(),
    },
    { type: 'separator' },
    { role: 'quit' },
  ]);

  tray.setContextMenu(contextMenu);

  // Clicking the icon (mainly Windows/Linux) surfaces the main window.
  tray.on('click', () => showMainWindow());

  return tray;
};

/** Destroys the tray. Call on app quit to release the native resource. */
export const destroyTray = (): void => {
  if (tray) {
    tray.destroy();
    tray = null;
  }
};

// Ensure the tray is cleaned up when the app is quitting.
app.on('before-quit', destroyTray);
