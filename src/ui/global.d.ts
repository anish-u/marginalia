import type { MarginaliaApi } from '@shared/ipc';

/**
 * Augments the renderer's `window` with the API injected by the preload
 * script through `contextBridge.exposeInMainWorld`.
 */
declare global {
  interface Window {
    marginalia: MarginaliaApi;
  }
}

export {};
