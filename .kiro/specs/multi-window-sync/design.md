# Design Document

## Overview

This design fixes three defects in the multi-window resource-note experience introduced by `vault-and-notes`: cross-window edits not syncing (especially the create-then-open flow), a flood of redundant change broadcasts, and highlights disappearing after in-page navigation.

The unifying model is **the on-disk Note_File is the single source of truth, and windows are views that converge to it**. A change to a note's file produces exactly one notification; every window bound to that note reloads from disk unless it has unsaved local edits it must not lose. This is deliberately *reload-on-change*, not real-time co-editing — a pragmatic, correct convergence model that matches the app's existing autosave design without a CRDT.

All changes stay within the established architecture: the renderer never touches the filesystem; persistence flows through the typed preload bridge; window creation stays in the main process.

## Root-cause analysis

### A. Create-then-open does not sync; create-close-reopen does

Today a Note_Window acquires its identity in one of two ways:

- **Loaded note:** opened with `?noteId=<id>` (from the launcher's `openNoteWindow`). `ResourceNoteView` reads the id from the route on mount and binds `noteIdRef.current = id` immediately, before any edit.
- **Fresh note:** opened with `?url=&title=` and **no** `noteId`. `noteIdRef.current` starts `null` and is assigned **lazily inside the first `save()`** via `allocateNoteId(title)`.

The cross-window reload logic (`onNotesChanged`) only reacts when `noteIdRef.current === info.id`. This is why the two flows differ:

- **Create → close → reopen** works: after the creator window is closed and the note is reopened from the launcher, *both* windows (if reopened twice) load with `?noteId=`, bind their identity up front, and converge cleanly.
- **Create → open same note (creator still open)** fails: the creator window (A) assigned its id lazily and keeps behaving as the "authoring" window. When the second window (B) edits and the broadcast arrives at A, A is prone to (a) an identity/timing mismatch, and (b) fighting over `Pending_Local_Edits` / echo of its own saves. The two windows are not symmetric, so convergence is unreliable.

**Fix direction:** make a created note's identity *first-class as soon as it exists on disk*, and make both windows symmetric (a "created" window becomes indistinguishable from a "loaded" window once its id is assigned). Concretely: assign the note id **eagerly** (on window mount / before the first edit) rather than lazily inside `save()`, so the window is a Bound_Note from the start; and treat the reload path identically for created and loaded windows.

### B. Too many broadcasts

Three independent sources currently emit `notes:changed`:

1. **Explicit write/delete/rename** in `ipc/notes.ts` — the correct, intended source (carries the note `id`).
2. **`browser-window-focus`** in `index.ts` — broadcasts a payload-less event on *every* window focus change. This is the primary flood and is not tied to any actual change.
3. **The On_Disk_Watcher** — `fs.watch` fires for every filesystem change, *including the app's own writes*, so each in-app save produces the explicit broadcast **plus** a watcher echo (fs.watch is also inherently noisy, firing multiple raw events per operation).

**Fix direction:** remove the focus-based broadcast entirely; keep the watcher but suppress its notifications for changes the app itself just made (a short "app just wrote" quiet window), so the watcher only fires for genuinely external changes. Keep the watcher's existing debounce for coalescing.

### C. Highlights lost on navigation

`useAnnotator` re-injects the annotator on every `dom-ready` and sets a boolean `ready`. The repaint effect keyed on that boolean only runs on the first `false→true` transition; a later navigation re-injects into a fresh guest document (whose annotator state is empty) but does not re-run the repaint, so highlights vanish.

**Fix direction:** drive the repaint off a signal that changes on *every* (re)injection, not just the first. (A `readyTick` counter that increments per `dom-ready`, with the repaint effect depending on it.) This portion is small and largely already prototyped; the spec formalizes it and adds a regression test.

## Architecture

### Where the changes live

```
src/
  shared/
    ipc.ts                      # EXTEND  NotesChangedInfo already carries { id?, oldId?, newId? }
  electron/
    index.ts                    # EDIT    remove the browser-window-focus broadcast
    ipc/
      notes.ts                  # EDIT    single broadcast per action; suppress watcher echo window
    vault/
      notes-watcher.ts          # EDIT    add "app-write quiet window" suppression; keep debounce
  ui/
    hooks/
      use-annotator.ts          # EDIT    readyTick bumped on every dom-ready (fix C)
    views/
      ResourceNoteView.tsx      # EDIT    eager id assignment; symmetric reload; content-equality guard
```

No new modules are required; this is a focused set of edits plus tests.

## Components and interfaces

### Eager Note_Identity assignment (fix A)

Today (lazy):

```
save():
  if (!noteIdRef.current) noteIdRef.current = allocateNoteId(title) ?? makeId()
  writeNote({ id: noteIdRef.current, ... })
```

Proposed (eager): on mount, if the window is a Fresh_Note (no `?noteId=`) and a vault is active, allocate the id up front and treat the window as bound from then on. The first `save()` then writes under the already-assigned id, and the window's `onNotesChanged` handler can match `info.id` from the very first save onward.

Sequencing considerations:
- `allocateNoteId` requires an active vault; if none is active, remain a Fresh_Note (no identity, no sync — Req 1.4) and allocate on first save as today.
- Eager allocation derives the id from the *initial* title (possibly empty → default slug). This is consistent with the existing behavior where the id is a title-derived slug fixed at creation and stable thereafter; later title edits do not move the file (only explicit rename does, per `vault-and-notes`).
- Because two Fresh_Note windows created independently would each allocate their own id, "same note in two windows" is only meaningful once the note exists on disk and is opened by id — which is exactly the create-then-open flow this fixes.

### Symmetric reload + echo handling (fix A + Req 2/4)

The `onNotesChanged` handler in `ResourceNoteView` handles two cases for the window's Bound_Note:

1. **Rename adoption** (`info.oldId === currentId`): set `noteIdRef.current = info.newId`, then reload if clean.
2. **Content reload** (`info.id === currentId`): reload from disk if the window has no Pending_Local_Edits.

Guards to make this correct and non-disruptive:
- **Pending_Local_Edits gate:** a `pendingSaveRef` is `true` from the moment a change arms the autosave debounce until the resulting write flushes. While `true`, skip reload (Req 2.2) — the window's own save wins.
- **Echo is a no-op:** the saving window is clean by the time its own broadcast returns, so it would reload identical content. To avoid resetting the cursor, add a **content-equality guard**: before applying a reload, compare the freshly-read note's serialized content (prose + title + highlights) to what the window currently holds; if identical, skip the editor `setContent` entirely (Req 4.3).
- **No feedback loop:** the reload applies content programmatically with `emitUpdate: false` and a `hydratingRef` that suppresses the dirty-marking effect, so a reload never marks the note dirty or triggers another save/broadcast (Req 2.3).

Optionally, to make echo handling airtight, the broadcast MAY carry a `Change_Origin` (the sender `webContents.id`) so the originating window can skip outright. The content-equality guard already covers the echo, so `Change_Origin` is an optional refinement, not required.

### Broadcast de-duplication (fix B / Req 3)

- **Remove** the `browser-window-focus → broadcastNotesChanged()` handler in `index.ts` (Req 3.3).
- **Suppress the watcher echo for app writes.** Add a short "app-write quiet window" to the watcher: whenever the app performs a write/delete/rename, it calls a `noteWriteInProgress()`/`markAppWrite()` hook that makes the watcher ignore filesystem events for a brief interval (e.g. the debounce interval). The explicit broadcast from the write handler is the single source of truth for in-app changes (Req 3.1, 3.2). Genuinely external changes (no recent app write) still fire one debounced, payload-less broadcast (Req 3.4, 3.5).

Broadcast payload semantics (already modeled by `NotesChangedInfo` = `{ id?, oldId?, newId? }`):
- write → `{ id }`
- delete → `{ id }`
- rename (moved) → `{ id: newId, oldId, newId }`; rename (same slug) → `{ id }`
- external/watcher → `null` (generic; lists re-fetch, note windows ignore since no id matches)

### Highlight re-paint on navigation (fix C / Req 5)

`useAnnotator` exposes a `readyTick` that increments on every successful annotator injection (every `dom-ready`). `ResourceNoteView`'s repaint effect depends on `readyTick` (in addition to `highlights`), so each guest (re)load re-paints the current highlights and recomputes the "not found on page" set (Req 5.1, 5.2, 5.4). Highlights live in React state independent of the guest page, so navigating away never drops them (Req 5.3).

## Data models

No on-disk format changes. `NotesChangedInfo` (already present in `@shared/ipc`) is the only cross-process shape involved:

```ts
interface NotesChangedInfo {
  id?: string;     // the note written/deleted/renamed (new id for a rename)
  oldId?: string;  // rename: previous id
  newId?: string;  // rename: new id
}
```

If `Change_Origin` is adopted as the optional refinement, it would be an additional `originId?: number` (a `webContents.id`) on this shape, set by the write handlers from `event.sender.id`.

## Correctness properties

These are the invariants the implementation and tests must uphold:

1. **Identity stability:** once a note has a Note_Identity, ordinary autosave never changes it; only explicit rename does. A created note's identity is assigned before or at its first persistence and is the same identity a second window binds to. (Req 1)
2. **Convergence when clean:** a Bound_Note window with no Pending_Local_Edits, upon a change to its note, ends with title/prose/highlights equal to on-disk content. (Req 2.1)
3. **No clobber when dirty:** a Bound_Note window with Pending_Local_Edits does not reload; its pending save persists. (Req 2.2)
4. **No feedback loop:** a reload does not mark the note dirty, does not save, and does not emit a Notes_Changed_Event. (Req 2.3)
5. **Echo is inert:** the window that saved does not visibly change from its own broadcast (identical content ⇒ no editor reset). (Req 4)
6. **One broadcast per action:** a single in-app write/delete/rename yields exactly one renderer notification; the watcher does not double-fire for it. (Req 3.1, 3.2)
7. **External changes still surface:** a change made outside the app produces exactly one debounced notification and the launcher list updates. (Req 3.4, 3.5)
8. **Highlights survive navigation:** after navigating away and back, the note's highlights are re-painted; none are dropped from the note. (Req 5)

## Testing strategy

Per the tech steering (`vitest run`; `tsc --build` + `eslint` as the correctness signals; no `npm test` assumption beyond the configured script):

- **Store/handler level (node env, mocked `electron`):** extend the existing captured-handler pattern (`ipc/__tests__/notes.broadcast.test.ts`) to assert exactly one broadcast per action and correct payloads; add a test that a simulated app write does not also produce a watcher echo (watcher suppressed).
- **Watcher unit (node env):** the "app-write quiet window" suppresses events during the interval and resumes after; external events still notify (debounced).
- **Renderer (jsdom + RTL):** where feasible without over-mounting Tiptap/webview, unit-test the reload decision: clean window reloads on a matching `info.id`; dirty window (pending save) does not; a reload with content equal to current is a no-op (no editor reset). The heavy `ResourceNoteView` mount may be exercised with a stubbed `window.marginalia` and a stubbed editor handle.
- **Annotator repaint:** unit-test that `useAnnotator` bumps `readyTick` on each simulated `dom-ready` so the consumer repaint re-runs (a lightweight hook test or a focused component test with a fake webview element).
- **Regression:** the full existing suite must remain green (Req 6.4).
