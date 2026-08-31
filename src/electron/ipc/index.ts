import { registerAppInfoHandlers } from './app-info';
import { registerWindowHandlers } from './windows';

/**
 * Composition root for all IPC handlers.
 *
 * As you add feature domains, create a `register<Feature>Handlers` function in
 * its own file next to this one and call it here. `index.ts` (the app entry)
 * calls this once on startup and never needs to change.
 */
export const registerIpcHandlers = (): void => {
  registerAppInfoHandlers();
  registerWindowHandlers();
  // registerSettingsHandlers();
  // registerFileHandlers();
};
