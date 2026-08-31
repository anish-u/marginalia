import { defineConfig } from 'vitest/config';

import { aliases } from './webpack.aliases';

/**
 * Vitest configuration.
 *
 * This repo had no test runner until the vault-and-notes feature; Vitest was
 * chosen because it is TS-native, ESM-friendly, and covers both the pure Node
 * modules (serialization, store, vault manager) and the React renderer via
 * jsdom. It is dev-only and never ships in the packaged app.
 *
 * Path aliases are reused verbatim from `webpack.aliases.ts` (the single source
 * of truth for `@main`/`@ui`/`@shared`/`@`) so test imports resolve exactly the
 * way the app's webpack builds do — no drift between the two.
 *
 * Environment strategy:
 *  - The default environment is `node`. Most of this feature's logic is pure
 *    main-process code (filesystem-backed store, YAML serialization) that has no
 *    business touching a DOM, so `node` is both correct and faster.
 *  - Renderer tests that need a DOM (React Testing Library) opt in per file with
 *    a docblock at the very top of the file:
 *
 *        // @vitest-environment jsdom
 *
 *    Vitest reads this comment before running the file and swaps the environment
 *    for that file only. We use this per-file convention rather than a global
 *    glob so the fast `node` default stays the norm and DOM tests are explicit.
 *    The jsdom-only setup (jest-dom matchers) is wired in `vitest.setup.ts`.
 */
export default defineConfig({
  resolve: {
    alias: aliases,
  },
  test: {
    // Vitest globals (`describe`, `it`, `expect`, `vi`, ...) without importing.
    globals: true,
    environment: 'node',
    // `tsc --build` emits compiled copies of source (including any co-located
    // `*.test.ts`) into `dist/`, and webpack writes to `.webpack/`. Vitest's
    // default exclude only covers node_modules/.git, so without these the runner
    // would discover and re-run the compiled `.js` duplicates. Exclude all build
    // output so only the TypeScript sources are tested.
    exclude: ['**/node_modules/**', '**/.git/**', 'dist/**', '.webpack/**', 'out/**'],
    // Runs before each test file; registers @testing-library/jest-dom matchers.
    // It is a no-op under the `node` environment (guarded inside the file), so
    // it is safe to load globally.
    setupFiles: ['./vitest.setup.ts'],
  },
});
