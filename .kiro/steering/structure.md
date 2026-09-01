# Project Structure & Conventions

## Three source trees

All code lives under `src/`, split by process/target. Each tree has a path alias and its own tsconfig.

```
src/
  electron/   # Main process (Node)     — alias @main   — tsconfig.electron.json (CommonJS, Node lib)
  shared/     # Cross-process types     — alias @shared
  ui/         # Renderer (Chromium/React)— aliases @ui and @ — tsconfig.ui.json (ESNext, DOM lib, react-jsx)
```

### `src/electron` (`@main`) — main process

- `index.ts` — app entry. On `app.ready` it runs, in order: install CSP → register IPC handlers → install menu → create tray → create main window. Also handles the macOS `window-all-closed` / `activate` lifecycle.
- `preload.ts` — the **only** bridge between processes. Uses `contextBridge.exposeInMainWorld('marginalia', api)` with an `ipcRenderer.invoke`-based implementation. No node integration in the renderer.
- `ipc-channels.ts` — an `IpcChannels` enum of channel strings.
- `ipc/` — IPC handlers, **one file per feature domain** (`app-info.ts`, `windows.ts`), composed in `index.ts` (`registerIpcHandlers`).
- `windows/` — window factory functions, **one file per window** (`main.ts`, `note.ts`, `resource-note.ts`), barrel-exported from `index.ts`.
- `menu.ts`, `tray.ts`, `security.ts` — application menu, system tray, and CSP installation.

### `src/shared` (`@shared`) — cross-process contracts

- `ipc.ts` — the `MarginaliaApi` interface, the single source of truth for the preload↔renderer contract.
- `highlight.ts` — `Highlight` / `ClipResult` types, shared between the renderer and the injected guest annotator.

### `src/ui` (`@ui`, `@`) — renderer

- `renderer.tsx` — React entry; mounts `<App/>` under `StrictMode`, imports `index.css`.
- `App.tsx` — `HashRouter` mapping routes to views (`/`, `/note`, `/resource-note`).
- `views/` — one file per view (`MainView`, `NoteView`, `ResourceNoteView`).
- `components/` — app components, grouped by feature. `components/ui/` holds the shadcn/ui primitives (button, resizable, switch). `components/resource-note/` holds everything only the Resource Note view uses (`NoteEditor`, `FormattingMenu`, `CollapsedRail`, `HighlightsIndex`, and the custom Tiptap `highlight-quote-node`). Add a new feature folder (e.g. `components/common/` for app-wide shared components) as features grow rather than piling files in the `components/` root.
- `hooks/` — reusable React hooks (`use-annotator.ts`, the webview↔guest-annotator bridge). Hooks live here, separate from non-hook utilities in `lib/`.
- `lib/` — non-hook, non-component modules: `utils.ts` (`cn()`), `annotator.ts` (guest-page script), `theme.ts` (light/dark sync), `pointer-capture-guard.ts` (drag/webview workaround).
- `global.d.ts` — `<webview>` element types and the `Window.marginalia` augmentation.

## IPC pattern

The renderer never touches Electron directly. The flow is always:

```
React view → window.marginalia.X()  (preload bridge, @shared/ipc)
          → ipcRenderer.invoke(IpcChannels.X)
          → ipcMain.handle in a src/electron/ipc/*.ts domain module
```

To add a capability: add the method to `MarginaliaApi` (`@shared/ipc`), add a channel to `IpcChannels`, implement it in the preload, and register a handler in a domain module under `ipc/`. Window creation always stays in the main process — the renderer only sends intent.

## Multi-window architecture

All windows load the **same renderer bundle** (Forge emits one entry, `main_window`). The main process differentiates windows by appending a route hash to the webpack entry URL (`#/note`, `#/resource-note?url=...`); React Router renders the matching view. Every window uses `contextIsolation: true`, `nodeIntegration: false`, and the shared preload.

## Annotator / highlight system

`src/ui/lib/annotator.ts` exports `ANNOTATOR_SOURCE`, a self-contained IIFE **string** that is injected into the `<webview>` guest page via `executeJavaScript` on `dom-ready`. It does **not** run in the renderer — it runs in the guest document, where it installs `window.__marginalia` with `clip()`, `paint(list)`, and `scrollTo(id)`. Anchoring is text-quote based (prefix/suffix context matching); painting uses the CSS Custom Highlight API so the page DOM is never modified. When editing this file, remember it must remain plain, dependency-free JS once emitted as a string.

## TypeScript config (project references)

- `tsconfig.base.json` — shared strict options (ES2022, `strict`, `noUnusedLocals/Parameters`, `isolatedModules`).
- `tsconfig.electron.json` — main process: CommonJS, Node types, `@main`/`@shared` paths.
- `tsconfig.ui.json` — renderer: ESNext + `moduleResolution: bundler`, DOM libs, `react-jsx`, `@ui`/`@shared`/`@` paths.
- `tsconfig.json` — root project for build tooling (`forge.config.ts`, `webpack.*.ts`); references the two per-target projects so `tsc --build` checks everything.

## Path aliases

`webpack.aliases.ts` is the single source of truth: `@main`→`src/electron`, `@ui`→`src/ui`, `@shared`→`src/shared`, `@`→`src/ui`. Both main and renderer webpack configs use the full set (Forge bundles `preload.ts`, which imports `@main/*`, alongside the renderer). Keep these in sync with the `paths` in the tsconfigs. Prefer aliased imports over deep relative paths.

## Conventions

- **File naming:** React components are PascalCase `.tsx` (`MainView`, `NoteEditor`), including the Tiptap node view `highlight-quote-node.tsx` which is kept kebab-case as the one exception (it's a node definition more than a screen component). Hooks are kebab-case `use-*.ts` (`use-annotator.ts`). electron/shared/lib modules are kebab-case or lowercase `.ts` (`ipc-channels.ts`, `resource-note.ts`, `theme.ts`). One file per feature domain in `ipc/`, one per window in `windows/`, each with a barrel `index.ts`.
- **Doc comments:** the codebase favors thorough comments that explain the *why* (e.g., why HashRouter, why the CSP skips webviews, why the annotator is a string). Match this style — explain non-obvious decisions.
- **shadcn/ui:** add components under `src/ui/components/ui/`; import via `@/components/ui/*` and `@/lib/utils`.
- **Security posture:** keep `contextIsolation` on and `nodeIntegration` off. Route all main-process access through the single typed preload bridge. The strict app CSP deliberately exempts `<webview>` guests so external sites keep their own policies — do not force the app CSP onto guest pages.
