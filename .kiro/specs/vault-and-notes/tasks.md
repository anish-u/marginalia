# Implementation Plan: Vault and Notes

## Overview

This plan adds durable, file-based persistence to Marginalia. It follows the design exactly: the renderer never touches the filesystem — everything flows through the typed preload bridge (`renderer → window.marginalia.* → ipcRenderer.invoke → ipcMain.handle → src/electron/vault/*`). All new code is TypeScript, matching the existing stack.

The plan is ordered to validate the riskiest, most central piece first: the pure Markdown+frontmatter serialization round-trip (`note-file.ts`, Req 7.4 / Property 1). We stand up a test runner (Vitest + fast-check) before writing that code so the round-trip law is enforced from the start. From there it builds outward — the store, the vault manager, the IPC/preload wiring, then the renderer (notes list, load/autosave/re-anchoring) — with each step integrating into what came before so nothing is orphaned.

Because the design has a "Correctness Properties" section, property-based tests (fast-check, ≥100 iterations) cover the 13 properties over the pure serialization and store logic. UI states use React Testing Library + jsdom; the live-webview highlight behaviors use a small number of integration examples. Test sub-tasks are marked optional with `*`.

Verification per the tech steering: `npm run typecheck` and `npm run lint`, plus the newly added `vitest run`.

## Tasks

- [x] 1. Set up test tooling and shared persistence types
  - [x] 1.1 Add Vitest + fast-check and a `test` script to package.json
    - Add dev dependencies `vitest`, `fast-check`, `@vitest/ui` (optional), `jsdom`, `@testing-library/react`, `@testing-library/jest-dom`, and `@testing-library/user-event`, using caret ranges consistent with the existing `package.json` (do not touch the pinned `electron` version)
    - Add `"test": "vitest run"` to the `scripts` block
    - Create a `vitest.config.ts` at the repo root that resolves the `@main`/`@ui`/`@shared`/`@` aliases from `webpack.aliases.ts` (import and reuse it), sets `environment: 'node'` by default, and enables the jsdom environment for renderer test files (e.g. via `environmentMatchGlobs` or a per-file `// @vitest-environment jsdom` convention documented in a comment)
    - Add a test setup file wiring `@testing-library/jest-dom` matchers for the jsdom tests
    - Add `.eslintignore`/config note or `env` so test files (`*.test.ts`, `*.test.tsx`) lint cleanly; ensure `vitest` globals are recognized
    - _Requirements: 7.4 (enables the round-trip test), Testing Strategy_

  - [x] 1.2 Create shared resource-note types (`src/shared/resource-note.ts`)
    - Define `ResourceType`, `WebsiteLinkResource`, reserved `PdfResource`/`VideoResource`, the `Resource` discriminated union, `NoteContent`, `ResourceNote`, `ResourceNoteSummary`, `Result<T>`, `VaultError` (with the full `code` union), `VaultInfo`, and `ResourceNoteInput` exactly as specified in the design's Shared types section
    - Reuse the existing `Highlight` from `@shared/highlight` unchanged
    - Add doc comments explaining the discriminated union is closed so exhaustive switches are future-proof (Req 4.2, 4.4) and why errors are returned as data
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.6_

  - [x] 1.3 Write unit test asserting the resource union is closed and exhaustive
    - Add an example test with an exhaustive `switch` over `Resource['type']` that fails to compile / hits an unreachable `never` branch if a variant is unhandled, confirming `website-link` is implemented and `pdf`/`video` are reserved
    - _Requirements: 4.2, 4.4_

- [x] 2. Implement and verify the pure Note_File serialization (round-trip first)
  - [x] 2.1 Implement `note-file.ts` serialize/parse (`src/electron/vault/note-file.ts`)
    - Implement `serializeNote(note: ResourceNote): string` producing UTF-8 text: a YAML frontmatter block (`id`, `title`, `resource` with `type`/`url`, `created`, `modified`, ordered `highlights` array with all `Highlight` fields) followed by the note prose (treated as an opaque Markdown string embedded in the body)
    - Implement `parseNote(raw: string, id: string): Result<ResourceNote>` that splits frontmatter from body, validates the schema, and returns `unknown-resource-type` (naming the offending value) when `resource.type` is not recognized, and `note-unreadable` when the frontmatter is malformed
    - Keep this module Tiptap-free and I/O-free: it owns only the frontmatter + file envelope and treats prose as an opaque Markdown string (the Tiptap↔Markdown conversion lives in the renderer, task 8)
    - Add a minimal dependency-light YAML approach consistent with the design (a small YAML lib added as a dependency, or a purpose-built serializer) — prefer an existing well-maintained YAML package pinned with a caret range
    - _Requirements: 7.1, 7.3, 4.5, 4.6_

  - [x] 2.2 Write the round-trip property test for `note-file.ts`
    - `// Feature: vault-and-notes, Property 1: Note serialization round-trip preserves the note`
    - Add a fast-check `ResourceNote` arbitrary: website-link resources with valid http/https urls, 0–255-char titles (incl. whitespace-only), opaque Markdown prose strings (unicode included), and ordered highlight arrays with arbitrary text/prefix/suffix
    - Assert `parseNote(serializeNote(note), note.id)` is `ok` and equivalent to the original at the title / resource / prose-text / ordered-highlight level as defined in Property 1
    - **Property 1** — **Validates: Requirements 7.4, 4.6, 5.2, 6.3, 7.3**

  - [x] 2.3 Write property test for unrecognized resource type
    - `// Feature: vault-and-notes, Property 5: Unrecognized resource type is a non-destructive error`
    - Generate note files whose frontmatter `type` is an arbitrary non-recognized string; assert `parseNote` returns `unknown-resource-type` whose message includes the offending value and that the input string is returned unmodified (parse is pure — no disk write here)
    - **Property 5** — **Validates: Requirements 4.5**

- [x] 3. Checkpoint - core serialization proven
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Implement the Note_Store (read/write/list against a real folder)
  - [x] 4.1 Implement `note-store.ts` write with atomic commit, timestamps, default title, and path-traversal guard (`src/electron/vault/note-store.ts`)
    - Implement `write(vaultPath, note): Promise<Result<ResourceNote>>`: resolve `id` to `<vault>/notes/<id>.md`, **reject ids that escape the notes directory (path-traversal guard)**, write to a temp file in the same directory then `rename` over the target (atomic), set `modifiedAt` to write-start clock, set `createdAt` on first write and preserve it from the existing file on overwrite, substitute the default title (`"Untitled note"`) when the input title is blank/whitespace, and return `write-failed` (naming the note id) on failure while leaving any prior file untouched
    - Delegate serialization to `serializeNote` from task 2.1; create the `notes/` subdir if missing
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.7, Error Handling → path safety_

  - [x] 4.2 Write property test for the path-traversal safety guard
    - `// Feature: vault-and-notes, path-traversal safety guard (Error Handling → path safety)`
    - Generate malicious ids (`../`, absolute paths, `..\\`, nested separators) and assert `write`/`read` reject them and never touch a path outside `<vault>/notes/`
    - **Validates: Error Handling → path safety (upholds least-privilege posture)**

  - [x] 4.3 Write property tests for write timestamps, in-place overwrite, and default title
    - `// Feature: vault-and-notes, Property 8: Write sets timestamps correctly`
    - `// Feature: vault-and-notes, Property 9: Overwrite is in place (one file per id)`
    - `// Feature: vault-and-notes, Property 7: Empty/whitespace titles are stored as the default`
    - Exercise `write` against an OS temp directory; verify first-write vs overwrite timestamp semantics, that overwriting a given id yields exactly one file (no duplicate), and that whitespace/empty titles persist and read back as the default
    - **Properties 7, 8, 9** — **Validates: Requirements 5.7, 5.4, 4.7, 5.3**

  - [x] 4.4 Write property test for failed writes leaving the prior file byte-unchanged
    - `// Feature: vault-and-notes, Property 10: Failed writes leave the prior file byte-unchanged`
    - Use a thin fs seam / spy to force the commit (`rename`) step to error; assert the previously written file is byte-for-byte unchanged and the result is `write-failed` naming the affected id
    - **Property 10** — **Validates: Requirements 5.5**

  - [x] 4.5 Implement `note-store.ts` read and list with fault isolation
    - Implement `read(vaultPath, id): Promise<Result<ResourceNote>>`: resolve the guarded path, return `note-not-found` when the file is absent (leaving the vault unchanged), delegate to `parseNote`, and propagate `unknown-resource-type` / `note-unreadable` without modifying the file
    - Implement `list(vaultPath): Promise<Result<ResourceNoteSummary[]>>`: enumerate `notes/*.md`, parse each in a per-file try/catch, return summaries ordered by `modifiedAt` descending, skip unparseable files (leaving them on disk) and surface them in an additive `diagnostics?: VaultError[]` field on the success result; an empty or all-unparseable vault yields an empty list with no error
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.7, 4.5, 7.2_

  - [x] 4.6 Write property tests for listing order and per-file fault isolation
    - `// Feature: vault-and-notes, Property 3: Notes are listed most-recently-modified first`
    - `// Feature: vault-and-notes, Property 4: Per-file fault isolation on load`
    - `// Feature: vault-and-notes, Property 6: Opening a missing id is a non-destructive error`
    - Seed temp vaults with mixes of parseable notes and corrupt files; assert list returns exactly the parseable notes newest-first with diagnostics for each excluded file (files left byte-unchanged), and that reading a missing id returns `note-not-found` with the vault unchanged
    - **Properties 3, 4, 6** — **Validates: Requirements 3.1, 6.1, 6.7, 6.2, 6.4**

- [x] 5. Implement the Vault_Manager (create/open/recognize/persist active vault)
  - [x] 5.1 Implement `vault-manager.ts` marker recognition and folder designation (`src/electron/vault/vault-manager.ts`)
    - Implement `isVault(dir)` = `.marginalia/vault.json` exists and parses with `marginaliaVault: true`
    - Implement the marker-writing helper that creates `.marginalia/vault.json` (`{ "marginaliaVault": true, "version": 1 }`), returning `marker-create-failed` on write failure
    - Keep the Electron `dialog` call out of this pure recognition/marker logic so it can be tested without a UI
    - _Requirements: 1.2, 1.3, 2.2_

  - [x] 5.2 Write property tests for vault designate/recognize and open semantics
    - `// Feature: vault-and-notes, Property 11: Designate-then-recognize round-trip`
    - `// Feature: vault-and-notes, Property 12: Opening a valid vault sets it as the sole active vault`
    - `// Feature: vault-and-notes, Property 13: Opening an invalid vault folder errors without changing state`
    - Over temp folders: designating a writable folder then recognizing it succeeds; opening a valid vault sets it active leaving at most one active regardless of prior state; opening a folder with no marker returns `not-a-vault` and one with a malformed marker returns `vault-unreadable`, both leaving the active vault unchanged
    - **Properties 11, 12, 13** — **Validates: Requirements 1.2, 1.3, 2.2, 2.3, 2.4**

  - [x] 5.3 Implement `VaultManager` create/open/getActive/restore with dialog and last-active persistence
    - Implement `create()`: `dialog.showOpenDialog` with `['openDirectory','createDirectory']`; on confirm, adopt an existing vault without overwriting if a marker is present (Req 1.4) else create the marker, set active, persist path to `userData/vault-state.json`; cancel returns `{ ok: true, value: null }`; marker failure returns `marker-create-failed` leaving active vault unchanged
    - Implement `open()`: `dialog.showOpenDialog` with `['openDirectory']`; verify marker, set active (replacing any prior active vault), persist path; `not-a-vault` / `vault-unreadable` / cancel handled per Error Handling table
    - Implement `getActive(): VaultInfo | null` and `restore(): Promise<VaultInfo | null>` (read `userData/vault-state.json` on boot, ignore if the path no longer exists or is not a vault)
    - _Requirements: 1.1, 1.4, 1.5, 1.6, 1.7, 2.1, 2.3, 2.4, 2.5, 2.6_

  - [x] 5.4 Write example tests for dialog cancel, adopt-existing-vault, and restore
    - Mock Electron `dialog`; assert create/open cancel returns `{ ok: true, value: null }` and leaves the active vault unchanged (Req 1.6, 2.5); assert creating on a folder that already has a marker adopts it without overwriting contents (Req 1.4); assert `restore` ignores a stale/non-vault path
    - _Requirements: 1.1, 1.4, 1.6, 2.1, 2.5_

- [x] 6. Checkpoint - persistence layer complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Wire persistence through IPC and the preload bridge
  - [x] 7.1 Extend the IPC channel enum (`src/electron/ipc-channels.ts`)
    - Add `VaultCreate`, `VaultOpen`, `VaultGetActive`, `VaultChanged`, `NotesList`, `NoteRead`, `NoteWrite`, `OpenNoteWindow` with the channel strings from the design
    - _Requirements: 1.1, 2.1, 3.1, 3.6, 5.1, 6.1_

  - [x] 7.2 Extend the shared API contract (`src/shared/ipc.ts`)
    - Add `createVault`, `openVault`, `getActiveVault`, `onVaultChanged`, `listNotes`, `readNote`, `writeNote`, `openNoteWindow` to `MarginaliaApi` with the exact signatures from the design (importing types from `@shared/resource-note`)
    - _Requirements: 1.1, 2.1, 2.6, 3.1, 3.3, 3.6, 5.1, 6.1, 6.3_

  - [x] 7.3 Implement the vault IPC handlers with VaultChanged fan-out (`src/electron/ipc/vault.ts`)
    - `ipcMain.handle` for `VaultCreate`/`VaultOpen`/`VaultGetActive` delegating to a shared `VaultManager` instance; on a successful active-vault change, broadcast `VaultChanged` with `{ path, name } | null` to every window via `webContents.send`, reusing the fan-out pattern from `ipc/theme.ts`
    - _Requirements: 1.5, 2.2, 2.6, 3.3_

  - [x] 7.4 Implement the notes IPC handlers (`src/electron/ipc/notes.ts`)
    - `ipcMain.handle` for `NotesList`/`NoteRead`/`NoteWrite` delegating to `NoteStore` against the current active vault path from `VaultManager`; when no vault is active on write, return `no-vault` (Req 5.6); add the `OpenNoteWindow` handler that asks the main process to open a resource-note window for an id, returning `note-not-found`/`Result` errors per Req 3.8
    - _Requirements: 3.1, 3.6, 3.8, 5.6, 6.1, 6.4_

  - [x] 7.5 Write example test for save with no active vault
    - Assert `NoteWrite` with no active vault returns `no-vault` and creates no file
    - _Requirements: 5.6_

  - [x] 7.6 Register the new handler groups (`src/electron/ipc/index.ts`)
    - Call `registerVaultHandlers()` and `registerNotesHandlers()` in `registerIpcHandlers`
    - _Requirements: 1.1, 3.1, 5.1, 6.1_

  - [x] 7.7 Implement the preload bridge methods and restore-on-boot (`src/electron/preload.ts`, `src/electron/index.ts`)
    - Implement all new `MarginaliaApi` methods in the preload via `ipcRenderer.invoke`, and `onVaultChanged` by wrapping the `VaultChanged` listener and returning a disposer (mirroring `onThemeChanged`)
    - In `src/electron/index.ts`, call `VaultManager.restore()` after `registerIpcHandlers()` on `app.ready` so the last-active vault is restored on boot
    - _Requirements: 2.6, 3.3, 5.1, 6.1, 6.3_

- [x] 8. Implement Tiptap ↔ Markdown conversion in the renderer
  - [x] 8.1 Add the renderer-side prose conversion module (`src/ui/lib/note-markdown.ts`)
    - Add a Tiptap/ProseMirror Markdown serializer+parser configured with the editor schema (StarterKit + the custom `highlightQuote` node); pick a library consistent with the Tiptap 3 stack (e.g. `tiptap-markdown` / `prosemirror-markdown`) pinned with a caret range
    - Map the `highlightQuote` node to the `> [!highlight id=<id>]` blockquote directive on serialize, and parse a blockquote whose first line matches `^\[!highlight id=(\S+)\]` back into a `highlightQuote` node (text from remaining lines; `url` resolved from the frontmatter `highlights` array by id); a marker-less blockquote parses as a normal blockquote
    - Export `docToMarkdown(editor|json): string` and `markdownToDoc(markdown, highlights): TiptapContent`; the empty doc serializes to an empty body and parses back to an empty doc
    - _Requirements: 7.3, 4.6, 6.3_

  - [x] 8.2 Write unit tests for the highlightQuote directive mapping
    - Test serialize→parse of a doc containing highlightQuote blocks (id + text preserved, url resolved from frontmatter highlights, order preserved) and that a plain blockquote is untouched, plus the empty-doc case
    - _Requirements: 7.3, 4.6_

- [x] 9. Implement the notes-list UI in the main window
  - [x] 9.1 Build the notes-list components (`src/ui/components/notes/`)
    - Create `VaultEmptyState.tsx` (create/open actions wired to `createVault()`/`openVault()`), `NoteListItem.tsx` (title with whitespace/empty placeholder and a website-link type indicator), and `NotesListView.tsx` (fetch `listNotes()`, render one item per note newest-first, empty-state message when none, inline error surfaced on open failure)
    - Clicking an item calls `openNoteWindow(id)`; on failure the list stays unchanged and shows an inline error (Req 3.8)
    - _Requirements: 3.1, 3.2, 3.4, 3.5, 3.6, 3.7, 3.8_

  - [x] 9.2 Host the notes list in MainView and subscribe to vault changes (`src/ui/views/MainView.tsx`)
    - Render `VaultEmptyState` when no active vault (from `getActiveVault()`), else `NotesListView`; subscribe via `onVaultChanged` to re-fetch the list and clear selection on change (within 1s); retain the theme toggle and version in the list header/footer
    - _Requirements: 3.1, 3.2, 3.3, 2.6_

  - [x] 9.3 Write RTL + jsdom tests for the notes-list UI states
    - Mock `window.marginalia`; assert: no-vault shows create/open actions (3.2), empty vault shows the empty-state message (3.7), whitespace/empty title shows the placeholder (3.5), website-link type indicator renders (3.4), open-failure shows an inline error and leaves entries unchanged (3.8), and a `VaultChanged` event refreshes the list and clears selection (3.3)
    - _Requirements: 3.2, 3.3, 3.4, 3.5, 3.7, 3.8_

- [x] 10. Load, autosave, and re-anchor in the resource-note window
  - [x] 10.1 Accept an existing note id when opening a resource-note window (`src/electron/windows/resource-note.ts`)
    - Extend the window factory to accept an optional `noteId` and append `?noteId=<id>` (alongside/instead of the existing `?url=`) to the route hash so the renderer can load an existing note
    - Wire the `OpenNoteWindow` handler (task 7.4) to call this factory
    - _Requirements: 3.6, 6.3_

  - [x] 10.2 Load an existing note and add debounced autosave (`src/ui/views/ResourceNoteView.tsx`)
    - On mount, if `noteId` is present, call `readNote(id)`; populate title, drive the `<webview src>` from the resource url, hydrate the editor from `content.prose` via `markdownToDoc` (task 8.1), and set `highlights` from `content.highlights`
    - Add debounced autosave (~800ms idle): title edits, editor `onUpdate`, and highlight-set changes mark the note dirty and call `writeNote(...)` with `content.prose` produced via `docToMarkdown`; a fresh note generates its `id` once on first save (reuse the existing `makeId`); store the returned `createdAt`/`modifiedAt`
    - _Requirements: 5.1, 5.4, 6.3, 6.5_

  - [x] 10.3 Indicate highlights that cannot be re-anchored (`src/ui/views/ResourceNoteView.tsx`, `src/ui/components/resource-note/HighlightsIndex.tsx`)
    - After `paint(highlights)` on the live page, determine which highlight ids were not found (extend the annotator bridge to report painted ids, or compare) and mark those in `HighlightsIndex` with a muted "not found on page" badge while retaining them in the note and prose; nothing is dropped
    - _Requirements: 6.5, 6.6_

  - [x] 10.4 Write integration examples for restored-highlight scroll and not-found indication
    - With a stubbed annotator/webview bridge: clicking a restored highlight whose anchor is found triggers a scroll (6.5), and a highlight whose anchor is not found surfaces the not-found indication while remaining in the note (6.6)
    - _Requirements: 6.5, 6.6_

- [x] 11. Final checkpoint - verify the whole feature
  - Ensure `npm run typecheck`, `npm run lint`, and `vitest run` all pass; ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP; core implementation sub-tasks are never optional.
- Each task references specific requirement clauses and/or design properties for traceability.
- The plan front-loads the serialization round-trip (Property 1, Req 7.4) and the path-traversal guard as explicit tasks, per the design's central correctness concern and security posture.
- Property-based tests (fast-check, ≥100 iterations) cover all 13 design properties over the pure serialization and store logic; each is tagged with a `// Feature: vault-and-notes, Property N: ...` comment. UI states use RTL+jsdom; live-webview behaviors use a few integration examples.
- Performance bounds (Req 5.1 write ≤2s, Req 3.3 list refresh ≤1s) are treated as informal timed checks, not properties, per the Testing Strategy.
- `note-file.ts` stays Tiptap-free; the schema-aware Markdown conversion lives in the renderer (`src/ui/lib/note-markdown.ts`).

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["1.3", "2.1", "7.1"] },
    { "id": 2, "tasks": ["2.2", "2.3", "7.2", "8.1"] },
    { "id": 3, "tasks": ["4.1", "5.1", "8.2"] },
    { "id": 4, "tasks": ["4.2", "4.3", "4.4", "4.5", "5.2", "5.3"] },
    { "id": 5, "tasks": ["4.6", "5.4", "7.3", "7.4"] },
    { "id": 6, "tasks": ["7.5", "7.6", "10.1"] },
    { "id": 7, "tasks": ["7.7", "9.1"] },
    { "id": 8, "tasks": ["9.2", "10.2"] },
    { "id": 9, "tasks": ["9.3", "10.3"] },
    { "id": 10, "tasks": ["10.4"] }
  ]
}
```
