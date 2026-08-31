# Requirements Document

## Introduction

This is a bug-fix and refinement spec building on the `vault-and-notes` feature. Notes are now persisted to a vault and can be opened in multiple resource-note windows, but three defects undermine the multi-window experience:

1. **Cross-window edits do not sync.** When the same note is open in two windows, an edit made in one window is not reflected in the other, so the windows silently diverge and the last save clobbers the other's changes. This is most visible in the **create-then-open** flow: creating a note in one window and then opening that same note in a second window fails to sync, whereas creating, closing, and reopening the note does sync. The difference is that a freshly created note only acquires its stable identifier lazily on first save, so the two windows are not reliably bound to the same note identity.

2. **Excessive change broadcasts.** Every window-focus change and every in-app write triggers one or more `notes:changed` broadcasts to every window, and the on-disk watcher re-broadcasts the very same in-app writes it just observed. The result is redundant re-reads and console noise (multiple broadcasts per user action).

3. **Highlights disappear after in-page navigation.** In a resource-note's browser pane, navigating to another page and returning to the resource page loses the painted highlights, because the annotator is re-injected into the fresh guest document but the highlights are not re-painted.

The guiding constraints are unchanged from `vault-and-notes`: the vault folder on disk is the single source of truth; the renderer never touches the filesystem (all persistence flows through the typed preload bridge); and correctness must not come at the cost of clobbering a user's active typing.

This spec does **not** introduce real-time collaborative (character-by-character) co-editing or a CRDT. "Sync" here means *reload-on-change*: when a note's file changes, other windows showing that note converge to the on-disk content when they are not in the middle of their own unsaved edits.

## Glossary

- **Note_Window**: A resource-note window (`ResourceNoteView`) showing one note: a browser pane plus a rich-text editor.
- **Launcher_Window**: The main window (`MainView`) showing the notes list for the active vault.
- **Note_Identity**: The stable note identifier (the `id`, which is also the on-disk filename stem). A note has exactly one identity for its lifetime, though an explicit rename may change it (see `vault-and-notes` rename behavior).
- **Fresh_Note**: A note created in a Note_Window that has not yet been saved and therefore has no Note_Identity assigned. It acquires its identity on first save.
- **Bound_Note**: The note a given Note_Window is currently editing, referenced by its Note_Identity (once assigned).
- **Notes_Changed_Event**: The main→renderer broadcast (`notes:changed`) informing windows that the note set may have changed. It optionally carries which note changed (`id`) and, for a rename, the id move (`oldId`/`newId`).
- **Change_Origin**: The window (`webContents`) that initiated a note write/delete/rename, if any. An external filesystem change has no Change_Origin.
- **Pending_Local_Edits**: The state of a Note_Window that has typed or highlight/title changes not yet flushed to disk (an autosave debounce is armed or a save is in flight).
- **On_Disk_Watcher**: The main-process `fs.watch` on the active vault's `notes/` directory that detects changes made outside the app.
- **Highlight_Repaint**: Re-applying the note's Highlights onto the current guest page via the annotator so they are visible after the page (re)loads.

## Requirements

### Requirement 1: A created note has a stable identity that a second window can bind to

**User Story:** As a note-taker, I want a note I just created to sync with a second window I open on that same note, so that my edits stay consistent regardless of the order in which I opened the windows.

#### Acceptance Criteria

1. WHEN a Fresh_Note is first persisted, THE System SHALL assign it a Note_Identity and SHALL make that identity available such that a subsequently opened Note_Window on the same note binds to the same Note_Identity.
2. WHILE two Note_Windows are bound to the same Note_Identity, WHEN one window persists a change to the note, THE other window SHALL converge to the persisted content per Requirement 2, regardless of whether the note was originally created in one of those windows or loaded from the vault.
3. WHEN a Note_Window that created a Fresh_Note has assigned its Note_Identity, THE window SHALL thereafter be treated as a Bound_Note window equivalent to one that loaded an existing note (there SHALL be no behavioral difference in sync between a created note and a reopened note once the identity is assigned).
4. WHERE a note has never been persisted (still a Fresh_Note with no Note_Identity), THE System is NOT required to sync it to any other window, because no shared on-disk note yet exists.

### Requirement 2: Windows showing a note converge when that note changes on disk

**User Story:** As a note-taker with the same note open in two windows, I want an edit in one window to appear in the other, so that the windows do not silently diverge and overwrite each other.

#### Acceptance Criteria

1. WHEN a note's Note_File changes (written, renamed, or externally modified) AND a Note_Window is bound to that note's Note_Identity AND that window has no Pending_Local_Edits, THE window SHALL reload the note's title, prose, and Highlights from disk within 1 second of the change being observed.
2. IF a Note_Window bound to the changed note has Pending_Local_Edits, THEN THE window SHALL NOT reload (to avoid discarding the user's in-progress edits); the window's own pending save SHALL proceed and become the persisted state.
3. WHEN a Note_Window reloads note content in response to a change, THE reload SHALL NOT itself be treated as a user edit and SHALL NOT trigger a new save or a new Notes_Changed_Event (no reload feedback loop).
4. WHEN a note is renamed such that its Note_Identity changes AND a Note_Window is bound to the old identity, THE window SHALL adopt the new identity so that its subsequent saves target the renamed Note_File rather than recreating the old one.
5. WHILE a Launcher_Window is open, WHEN the note set changes, THE Launcher_Window SHALL refresh its list within 1 second (unchanged from `vault-and-notes` Req 3.3).

### Requirement 3: Change broadcasts are efficient and non-redundant

**User Story:** As a developer, I want note-change notifications to fire only when the note set actually changes and to avoid duplicate notifications for a single action, so that windows do not perform redundant reloads and the system stays predictable.

#### Acceptance Criteria

1. WHEN a single in-app note write, delete, or rename completes, THE System SHALL emit at most one Notes_Changed_Event describing that change to the renderer windows (duplicate events for the same underlying action SHALL be avoided).
2. WHERE the On_Disk_Watcher observes a filesystem change that was caused by the app's own just-completed write, THE System SHALL NOT emit an additional Notes_Changed_Event for that same change (the explicit write broadcast already covers it).
3. WHEN a window merely gains or loses focus without any change to the note set, THE System SHALL NOT emit a Notes_Changed_Event solely because of the focus change.
4. WHEN the On_Disk_Watcher observes one or more changes made outside the app within a short interval, THE System SHALL coalesce them into a single Notes_Changed_Event (debounced), and that event MAY omit a specific note id (a generic "notes changed" signal that causes lists to re-fetch).
5. THE System SHALL continue to detect and surface note changes made outside the app (e.g. a file deleted in Finder) so the Launcher_Window's list stays accurate, without relying on focus-based polling.

### Requirement 4: A window ignores the echo of its own change

**User Story:** As a note-taker, I want the window I'm typing in to keep my content, so that its own saved change is never treated as an external change to reload over.

#### Acceptance Criteria

1. WHEN a Note_Window persists a change and a resulting Notes_Changed_Event is delivered back to that same window, THE window SHALL NOT reload over the content it just saved.
2. WHERE a Notes_Changed_Event carries a Change_Origin, THE originating window MAY use it to skip its own reload; WHERE no Change_Origin is available, the window SHALL rely on being in a clean, just-saved state such that reloading identical on-disk content is a harmless no-op that does not disrupt the cursor or mark the note dirty.
3. WHEN a reload would replace editor content identical to what is already displayed, THE System SHOULD avoid a disruptive re-render (e.g. skip the reload when the on-disk content matches the current content) so the user's cursor/selection is not reset.

### Requirement 5: Highlights are re-painted after the browser pane navigates

**User Story:** As a note-taker, I want my clipped highlights to reappear when I navigate back to the resource page, so that my annotations are not lost by browsing away and returning.

#### Acceptance Criteria

1. WHEN the browser pane's guest document finishes (re)loading (including after navigating away and back), THE System SHALL re-inject the annotator and re-paint the note's current Highlights onto the newly loaded page.
2. WHEN Highlights are re-painted after a navigation, THE System SHALL indicate any Highlight whose text-quote anchor cannot be located on the now-current page, consistent with `vault-and-notes` Req 6.6, without dropping it from the note.
3. WHILE the browser pane is on a page other than the note's resource page, THE System SHALL retain all Highlights in the note; navigating away SHALL NOT delete or forget Highlights.
4. WHEN the user navigates back to the resource page after Highlights failed to anchor on an intermediate page, THE System SHALL re-attempt anchoring and paint the Highlights that now locate successfully.

### Requirement 6: No regressions to existing persistence guarantees

**User Story:** As a note-taker, I want these fixes to preserve the durability and correctness guarantees already in place, so that nothing I relied on breaks.

#### Acceptance Criteria

1. THE System SHALL preserve the `vault-and-notes` write guarantees: atomic writes, `createdAt` preservation across writes and renames, blank-title default substitution, and the path-traversal guard.
2. THE System SHALL preserve the `vault-and-notes` rename behavior: an explicit rename moves the Note_File to a new title-derived id (collision-safe), while ordinary autosave keeps the id stable.
3. THE System SHALL NOT introduce a separate database; the vault folder remains the single source of truth and all filesystem access flows through the main process.
4. WHEN the fixes are complete, THE existing automated test suite SHALL continue to pass, and new automated tests SHALL cover the fresh-note identity binding, the reload-when-clean / skip-when-dirty behavior, broadcast de-duplication, and highlight re-paint on navigation.
