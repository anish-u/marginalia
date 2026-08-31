# Product

Marginalia is a macOS-first Electron desktop app for note-taking centered on web research and highlighting. Its guiding idea, surfaced in the launcher, is to "capture a thought in its own window."

## What it does

The app opens lightweight note windows on demand. There are three window/view types:

- **Launcher (MainView, route `#/`)** — the main window. Shows the app title and version and spawns note windows via two actions: "New Note" and "New Resource Note."
- **Note (NoteView, route `#/note`)** — a minimal standalone note: a title field and a free-form body. Each note lives in its own small window.
- **Resource Note (ResourceNoteView, route `#/resource-note?url=...`)** — the flagship feature. A split window with a live browser pane (an Electron `<webview>`) on the left and a rich-text note editor on the right, separated by a draggable handle.

## The clipping workflow (Resource Note)

This is the core experience. The user browses a web page in the left pane, selects text, and "clips" it (Clip button or ⌘⇧H / Ctrl+Shift+H). Each clip:

1. Is painted onto the live page as a yellow highlight using the CSS Custom Highlight API — the page's DOM is never mutated.
2. Is inserted into the note as a clickable quote block at the cursor, so the user can write around it.

Clicking a clip in the note scrolls the web page back to it and flashes it. A collapsible highlights index at the bottom of the note pane lets the user jump to or remove clips. Highlights use resilient text-quote anchoring (surrounding-context matching) so they can be re-found after page reloads.

## Current state and constraints

- Note and highlight persistence is **not yet implemented** — state is in-memory per window. Persistence is planned; treat "saving notes" as future work when scoping changes.
- No test framework is set up yet.
- Multiple note and resource-note windows can be open at once; the launcher window is effectively singleton (recreated on macOS dock activation or from the tray).

When making product decisions, keep the app focused: fast, distraction-free capture in dedicated windows, with the browser-plus-notes clipping flow as the centerpiece.
