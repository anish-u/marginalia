/**
 * Theme (light/dark) management for the renderer.
 *
 * Marginalia is multi-window. `localStorage` persists the choice so a newly
 * opened window boots in the right theme, but it is NOT used to sync *already
 * open* windows: the browser `storage` event does not fire reliably between
 * separate Electron BrowserWindows. Live sync instead goes through the main
 * process — `setTheme` broadcasts over IPC (`window.marginalia.setTheme`) and
 * the main process fans it out to every other window, which each react via
 * `subscribeToThemeChanges` (backed by `window.marginalia.onThemeChanged`).
 *
 *   - `applyTheme` toggles the `.dark` class on <html> (Tailwind's dark variant
 *     keys off `.dark`, see index.css `@custom-variant dark`).
 *   - `getStoredTheme` reads the saved choice, defaulting to `dark` to match the
 *     app's dark-first design (index.html ships `<html class="dark">`).
 */

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'marginalia-theme';

/** Normalizes an arbitrary string to a Theme, defaulting to dark. */
function normalize(value: string | null | undefined): Theme {
  return value === 'light' ? 'light' : 'dark';
}

/** Reads the persisted theme, defaulting to dark (the app's dark-first choice). */
export function getStoredTheme(): Theme {
  try {
    return normalize(localStorage.getItem(STORAGE_KEY));
  } catch {
    // localStorage can throw in locked-down contexts; fall back to the default.
    return 'dark';
  }
}

/** Adds/removes the `.dark` class on the document root. */
export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark');
}

/**
 * Persists the theme, applies it to this window, and broadcasts it to every
 * other open window via the main process.
 */
export function setTheme(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Ignore persistence failures — the in-window class change below still
    // takes effect for this session.
  }
  applyTheme(theme);
  // Fan out to the other windows. Fire-and-forget; failures only affect live
  // sync, not this window (which already applied the change above).
  void window.marginalia.setTheme(theme);
}

/** Applies the persisted theme to this window. Call once on startup. */
export function initTheme(): void {
  applyTheme(getStoredTheme());
}

/**
 * Subscribes to theme changes broadcast from other windows (via the main
 * process). Applies the incoming theme to this window and notifies the caller
 * so it can update UI (e.g. the toggle). Returns an unsubscribe.
 */
export function subscribeToThemeChanges(
  onChange: (theme: Theme) => void,
): () => void {
  return window.marginalia.onThemeChanged((value) => {
    const theme = normalize(value);
    // Keep localStorage current so a later-opened window matches, and apply the
    // class to this window before notifying the caller.
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Ignore persistence failures.
    }
    applyTheme(theme);
    onChange(theme);
  });
}
