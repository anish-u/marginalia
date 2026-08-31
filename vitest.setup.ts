/**
 * Global Vitest setup.
 *
 * Wires the `@testing-library/jest-dom` matchers (`toBeInTheDocument`,
 * `toHaveTextContent`, ...) into `expect` for the renderer/UI tests that run
 * under the jsdom environment.
 *
 * This file loads for every test file (see `setupFiles` in vitest.config.ts),
 * including the `node`-environment ones. Registering the matchers there is
 * harmless — they simply go unused — but importing the jest-dom entry pulls in
 * code that expects a DOM, so we only import it when a `document` actually
 * exists (i.e. under jsdom). Node-environment tests skip it entirely.
 */
if (typeof document !== 'undefined') {
  await import('@testing-library/jest-dom/vitest');
}
