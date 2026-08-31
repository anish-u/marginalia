# Implementation Plan

## Overview

This plan fixes three defects from `vault-and-notes`: cross-window note sync (the create-then-open case), redundant change broadcasts, and highlights lost on browser-pane navigation. It follows the design: the on-disk Note_File stays the single source of truth, the renderer never touches the filesystem, and reloads never clobber a user's unsaved edits.

Ordering is chosen to land the smallest, lowest-risk, independently-verifiable fix first (highlight re-paint), then the broadcast de-duplication (which reduces noise and makes the sync behavior observable/testable), then the core sync fix (eager identity + symmetric reload). Each step is verified with `npm run typecheck`, `npm run lint`, and `npm test`. Test sub-tasks are marked optional with `*`.

Diagnostics note: any temporary `console.log('[sync] …')` statements added while investigating SHALL be removed as part of task 5.

## Tasks

- [x] 1. Fix highlights lost after browser-pane navigation (Req 5)
  - [x] 1.1 Repaint on every guest (re)load in `use-annotator.ts`
    - Increment a `readyTick` counter on every successful annotator injection (`dom-ready`), not only the first `false→true` of the boolean `ready`; expose `readyTick` from the hook alongside `ready`.
    - In `ResourceNoteView.tsx`, make the highlight repaint effect depend on `readyTick` (plus `highlights`) so navigating away and back re-paints the current highlights and recomputes the unresolved ("not found on page") set.
    - Confirm highlights live in renderer state independent of the guest page, so navigation never drops them from the note (Req 5.3).
    - _Requirements: 5.1, 5.2, 5.3, 5.4_
  - [x] 1.2 Test the repaint-on-reinjection behavior
    - Add a focused test (hook-level with a fake webview EventTarget, or a component test with a stubbed webview) asserting `readyTick` increments on each simulated `dom-ready` and that the consumer's repaint runs again after a second `dom-ready`.
    - _Requirements: 5.1_

- [x] 2. Make change broadcasts efficient and non-redundant (Req 3)
  - [x] 2.1 Remove the focus-based broadcast (`src/electron/index.ts`)
    - Delete the `app.on('browser-window-focus', () => broadcastNotesChanged())` handler so window focus changes no longer emit `notes:changed` (Req 3.3). Rely on the explicit write broadcasts and the On_Disk_Watcher for refresh.
    - _Requirements: 3.3_
  - [x] 2.2 Suppress the watcher echo for the app's own writes (`notes-watcher.ts`, `ipc/notes.ts`)
    - Add an "app-write quiet window" to `notes-watcher.ts`: export a `markAppWrite()` (or similar) that starts/extends a short interval during which observed `fs.watch` events are ignored; keep the existing debounce for coalescing genuine external events.
    - Call `markAppWrite()` from the write/delete/rename handlers (or wrap the store writes) so an in-app change does not produce both the explicit broadcast and a watcher echo (Req 3.1, 3.2). Ensure the explicit broadcast still fires exactly once per action.
    - Preserve external-change detection: a filesystem change with no recent app write still fires one debounced, payload-less broadcast so the launcher list updates (Req 3.4, 3.5).
    - _Requirements: 3.1, 3.2, 3.4, 3.5_
  - [x] 2.3 Test single-broadcast-per-action and no watcher echo
    - Extend `ipc/__tests__/notes.broadcast.test.ts` (captured-handler + mocked `electron` pattern) to assert exactly one broadcast per write/delete/rename with the correct payload, and that a simulated app write does not additionally trigger the watcher notification (watcher suppressed during the quiet window). Add/keep a case that an external change (no recent app write) still notifies once.
    - _Requirements: 3.1, 3.2, 3.4, 3.5_

- [x] 3. Give a created note a stable identity a second window can bind to (Req 1)
  - [x] 3.1 Assign the Note_Identity eagerly in `ResourceNoteView.tsx`
    - On mount, when the window is a Fresh_Note (no `?noteId=`) and a vault is active, allocate the id up front via `allocateNoteId(initialTitle)` and set `noteIdRef.current` before the first edit, so the window is a Bound_Note from the start and its `onNotesChanged` handler can match `info.id` from the first save.
    - When no vault is active, remain a Fresh_Note (allocate lazily on first save, as today) — such a note cannot sync because no shared file exists yet (Req 1.4).
    - Ensure created and loaded windows are behaviorally identical once bound (no separate "authoring" code path) (Req 1.3).
    - Keep id stability: eager allocation fixes the id at creation; later title edits do not move the file (only explicit rename does, per `vault-and-notes`).
    - _Requirements: 1.1, 1.2, 1.3, 1.4_

- [x] 4. Converge windows on change without clobbering edits (Req 2, 4)
  - [x] 4.1 Symmetric reload + pending-edits gate in `ResourceNoteView.tsx`
    - In `onNotesChanged`: for the window's Bound_Note, handle rename adoption (`info.oldId === currentId` → adopt `info.newId`) and content reload (`info.id === currentId`).
    - Reload only when the window has no Pending_Local_Edits, tracked by a `pendingSaveRef` set `true` when a change arms the autosave debounce and cleared when the write flushes (Req 2.1, 2.2).
    - Make the reload programmatic and non-dirtying: apply via the editor's `setContent(..., emitUpdate=false)` and a `hydratingRef` that suppresses the title/highlights dirty effect, so a reload never marks dirty, saves, or re-broadcasts (Req 2.3).
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_
  - [x] 4.2 Make the echo inert with a content-equality guard (Req 4)
    - Before applying a reload, compare the freshly-read note (title + prose + ordered highlights) to the window's current content; if identical, skip the editor `setContent` so the saving window's own broadcast does not reset its cursor/selection (Req 4.1, 4.3).
    - Optionally (refinement, not required): thread a `Change_Origin` (`event.sender.id`) through the broadcast so the originating window can skip its own reload outright; the equality guard already covers correctness, so implement only if it simplifies reasoning.
    - _Requirements: 4.1, 4.2, 4.3_
  - [x] 4.3 Test the reload decision matrix
    - Add renderer tests (jsdom, stubbed `window.marginalia` + stubbed editor handle): a clean Bound_Note reloads on a matching `info.id`; a window with pending edits does not reload; a reload whose content equals current content does not reset the editor; rename adoption updates the bound id then reloads when clean.
    - _Requirements: 2.1, 2.2, 2.3, 4.1, 4.3_

- [x] 5. Remove diagnostics and verify the whole fix (Req 6)
  - [x] 5.1 Strip temporary sync diagnostics
    - Remove any temporary `[sync]` `console.log` statements added during investigation from `ipc/notes.ts` and `ResourceNoteView.tsx`.
    - _Requirements: 6.4_
  - [x] 5.2 Full verification and manual smoke test
    - Run `npm run typecheck`, `npm run lint`, and `npm test`; all must pass (Req 6.4), with existing persistence/rename guarantees intact (Req 6.1, 6.2, 6.3).
    - Manually verify the reported flows: (a) create a note in one window, open the same note in a second window, edit in one — the other converges when idle; (b) rapid focus switching no longer floods broadcasts; (c) navigate the browser pane away and back — highlights reappear.
    - _Requirements: 6.1, 6.2, 6.3, 6.4_
