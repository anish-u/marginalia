/**
 * Barrel for window factories.
 *
 * Re-export each window's create function here so callers import from
 * `@main/windows` regardless of how many window files exist:
 *
 *   export { createSettingsWindow } from './settings';
 *   export { createAboutWindow } from './about';
 */
export { createMainWindow } from './main';
export { createNoteWindow } from './note';
export { createResourceNoteWindow } from './resource-note';
