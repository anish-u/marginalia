import * as path from 'path';

/**
 * Single source of truth for webpack path aliases.
 *
 * Both the main and renderer webpack configs use the full set. This matters
 * because Electron Forge bundles the preload script (an Electron-side file that
 * imports from `@main/*` and `@shared/*`) together with the renderer, so the
 * renderer resolver must also understand `@main`. Keeping one shared map avoids
 * the two configs drifting apart.
 *
 * These mirror the `paths` entries in tsconfig.electron.json / tsconfig.ui.json,
 * which drive type-checking and editor navigation.
 */
export const aliases: Record<string, string> = {
  '@main': path.resolve(__dirname, 'src/electron'),
  '@ui': path.resolve(__dirname, 'src/ui'),
  '@shared': path.resolve(__dirname, 'src/shared'),
  // shadcn/ui components import from `@/components/ui/*` and `@/lib/utils` by
  // convention. Point `@` at the renderer root so those resolve into src/ui.
  '@': path.resolve(__dirname, 'src/ui'),
};
