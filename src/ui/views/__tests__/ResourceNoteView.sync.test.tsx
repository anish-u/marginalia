// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

/**
 * RTL + jsdom tests for the cross-window reload decision matrix (task 4.3).
 *
 * These exercise `ResourceNoteView`'s `onNotesChanged` handler — the core of
 * the multi-window sync fix — through the same seams the app uses:
 *
 *   - `window.marginalia` is stubbed as a full {@link MarginaliaApi} of
 *     `vi.fn()`s (same pattern as `MainView.test.tsx`), and the last
 *     `onNotesChanged` subscriber is captured on `capturedNotesChange` so a
 *     test can fire a `notes:changed` broadcast the way the main process would.
 *   - The heavy pieces that don't work under jsdom are mocked to inert stubs:
 *     the `<webview>`-driven `useAnnotator` / `useWebviewNav` hooks, and the
 *     Tiptap-backed `NoteEditor`. The fake `NoteEditor` exposes a controllable
 *     `getJSON` and a `setContent` **spy** via `useImperativeHandle`, which is
 *     exactly the seam the reload path drives (`editorRef.current`).
 *   - `@ui/lib/note-markdown` is mocked so the content-equality guard is
 *     deterministic: `docToMarkdown(json)` returns the doc's `__prose` field
 *     and `markdownToDoc(prose)` returns a tagged object. This lets a test make
 *     the editor's *current* prose match (or differ from) the freshly-read
 *     note's prose precisely, so we can assert whether `setContent` was called.
 *
 * The matrix under test (from the design's reload guards):
 *   - Clean Bound_Note reloads on a matching `info.id`                  (Req 2.1)
 *   - A window with Pending_Local_Edits does NOT reload                 (Req 2.2)
 *   - A reload whose content equals current does NOT reset the editor   (Req 4.1, 4.3)
 *   - Rename adoption ({ oldId, newId }) adopts newId, then reloads     (Req 2.4)
 *
 * Reload is asserted at the boundary: a reload calls `readNote(id)` and, unless
 * the content is identical, `editorRef.setContent(...)`. Absence of a reload is
 * "no `readNote` for that id + no `setContent`".
 *
 * Validates: Requirements 2.1, 2.2, 2.3, 4.1, 4.3
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { forwardRef, useImperativeHandle } from 'react';
import type { ReactNode } from 'react';
import type { JSONContent } from '@tiptap/core';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MarginaliaApi, NotesChangedInfo } from '@shared/ipc';
import type { Highlight } from '@shared/highlight';
import type { ResourceNote, Result } from '@shared/resource-note';

// --- Module mocks ----------------------------------------------------------

// A tagged doc the fake editor round-trips through the mocked markdown module.
// `__prose` is what `docToMarkdown` returns for it, so a test controls the
// editor's "current prose" by controlling this string.
interface FakeDoc extends JSONContent {
  __prose: string;
}

// The current doc the fake editor reports from `getJSON`. Mutable per test so a
// test can seed the editor's live content before firing a broadcast.
let currentDoc: FakeDoc = { type: 'doc', __prose: '' };
// Spy for the editor's `setContent`, asserted by the reload tests.
const setContentSpy = vi.fn();

// Deterministic markdown seam. `docToMarkdown` reads the tagged `__prose` off
// the doc; `markdownToDoc` tags the prose back onto a doc so a round trip is
// identity on the string we care about (the content-equality guard compares
// `docToMarkdown(currentJson)` against the note's stored `prose`).
vi.mock('@ui/lib/note-markdown', () => ({
  docToMarkdown: (doc: unknown) => (doc as FakeDoc)?.__prose ?? '',
  markdownToDoc: (prose: string): FakeDoc => ({ type: 'doc', __prose: prose }),
}));

// The webview-backed hooks touch an Electron `<webview>` element that doesn't
// exist under jsdom; stub them to inert values so the view mounts cleanly.
vi.mock('@ui/hooks/use-annotator', () => ({
  useAnnotator: () => ({
    webviewRef: { current: null },
    ready: false,
    readyTick: 0,
    paint: vi.fn().mockResolvedValue([]),
    scrollTo: vi.fn(),
    clip: vi.fn().mockResolvedValue(null),
  }),
}));

// The shadcn Resizable wraps react-resizable-panels, which reaches for a
// `ResizeObserver` on mount — unavailable under jsdom (`n is not a constructor`).
// The split-pane layout is irrelevant to the sync logic under test, so replace
// the primitives with plain passthrough elements.
vi.mock('@/components/ui/resizable', () => ({
  ResizablePanelGroup: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  ResizablePanel: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  ResizableHandle: () => null,
}));

vi.mock('@ui/hooks/use-webview-nav', () => ({
  useWebviewNav: () => ({
    currentUrl: 'https://example.com',
    canGoBack: false,
    canGoForward: false,
    loading: false,
    goBack: vi.fn(),
    goForward: vi.fn(),
    reload: vi.fn(),
    navigate: vi.fn(),
  }),
}));

// Fake NoteEditor: a forwardRef component exposing the same handle the view
// drives (`getJSON`, `setContent`, plus the no-op methods it may call). It
// renders nothing — the view only ever talks to it through the ref. `getJSON`
// returns the shared `currentDoc` so a test controls the editor's live content.
vi.mock('@ui/components/resource-note/NoteEditor', () => ({
  NoteEditor: forwardRef(function FakeNoteEditor(_props: unknown, ref: unknown) {
    useImperativeHandle(ref as never, () => ({
      insertHighlight: vi.fn(),
      removeHighlight: vi.fn(),
      focus: vi.fn(),
      setContent: (content: JSONContent, emitUpdate?: boolean) =>
        setContentSpy(content, emitUpdate),
      getJSON: () => currentDoc,
    }));
    return null;
  }),
}));

// Imported after the mocks so the view picks up the mocked modules.
import { ResourceNoteView } from '@ui/views/ResourceNoteView';

// --- Test helpers ----------------------------------------------------------

const highlight = (over: Partial<Highlight> = {}): Highlight => ({
  id: 'h-1',
  text: 'quoted text',
  prefix: 'before ',
  suffix: ' after',
  url: 'https://example.com',
  createdAt: 1_000,
  ...over,
});

/**
 * Build a persisted note. `prose`/`highlights` are accepted flat and mapped
 * into `content` for brevity (a note's body is what the reload tests vary).
 */
const note = (
  over: {
    id?: string;
    title?: string;
    prose?: string;
    highlights?: Highlight[];
    resource?: ResourceNote['resource'];
    createdAt?: number;
    modifiedAt?: number;
  } = {},
): ResourceNote => ({
  id: over.id ?? 'note-1',
  title: over.title ?? 'Loaded title',
  resource: over.resource ?? { type: 'website-link', url: 'https://example.com' },
  content: {
    prose: over.prose ?? 'loaded prose',
    highlights: over.highlights ?? [],
  },
  createdAt: over.createdAt ?? 1_000,
  modifiedAt: over.modifiedAt ?? 2_000,
});

const readOk = (n: ResourceNote): Result<ResourceNote> => ({ ok: true, value: n });

/** Last captured `onNotesChanged` subscriber, so a test can fire a broadcast. */
let capturedNotesChange:
  | ((info: NotesChangedInfo | null) => void)
  | undefined;

const makeApi = (over: Partial<MarginaliaApi> = {}): MarginaliaApi => {
  capturedNotesChange = undefined;
  return {
    getAppVersion: vi.fn().mockResolvedValue('1.0.0'),
    openResourceNoteWindow: vi.fn().mockResolvedValue(undefined),
    setTheme: vi.fn().mockResolvedValue(undefined),
    onThemeChanged: vi.fn().mockReturnValue(vi.fn()),
    createVault: vi.fn().mockResolvedValue({ ok: true, value: null }),
    openVault: vi.fn().mockResolvedValue({ ok: true, value: null }),
    getActiveVault: vi.fn().mockResolvedValue(null),
    onVaultChanged: vi.fn().mockReturnValue(vi.fn()),
    listNotes: vi.fn().mockResolvedValue({ ok: true, value: [] }),
    readNote: vi.fn(),
    writeNote: vi
      .fn()
      .mockResolvedValue(readOk(note({ createdAt: 1_000, modifiedAt: 3_000 }))),
    deleteNote: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    renameNote: vi.fn(),
    allocateNoteId: vi.fn().mockResolvedValue(null),
    openNoteWindow: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    onNotesChanged: vi.fn(
      (cb: (info: NotesChangedInfo | null) => void): (() => void) => {
        capturedNotesChange = cb;
        return vi.fn();
      },
    ),
    ...over,
  };
};

const installApi = (over: Partial<MarginaliaApi> = {}): MarginaliaApi => {
  const api = makeApi(over);
  window.marginalia = api;
  return api;
};

/**
 * Render the view for a window opened by `noteId` (the loaded-note flow, which
 * binds the id up front). A query string drives `useSearchParams`, so we mount
 * the view under a MemoryRouter with a matching route — the same `#/resource-note`
 * shape the app uses.
 */
const renderView = (query: string) =>
  render(
    <MemoryRouter initialEntries={[`/resource-note${query}`]}>
      <Routes>
        <Route path="/resource-note" element={<ResourceNoteView />} />
      </Routes>
    </MemoryRouter>,
  );

/** Wait until the initial load has settled (title reflects the loaded note). */
const waitForLoaded = async (title: string) => {
  await waitFor(() =>
    expect(screen.getByLabelText('Note title')).toHaveValue(title),
  );
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  currentDoc = { type: 'doc', __prose: '' };
});

// --- Clean Bound_Note reloads on a matching info.id (Req 2.1) --------------

describe('ResourceNoteView — clean window reloads on a matching id (Req 2.1)', () => {
  it('reads and applies the note content when a matching broadcast arrives', async () => {
    // Initial load returns the note; a later reload returns changed content.
    const readNote = vi
      .fn<(id: string) => Promise<Result<ResourceNote>>>()
      .mockResolvedValueOnce(readOk(note({ prose: 'loaded prose' })))
      .mockResolvedValue(
        readOk(note({ title: 'Edited elsewhere', prose: 'edited prose' })),
      );

    installApi({ readNote });
    renderView('?noteId=note-1');

    // The editor's current prose matches the initial load (so the load-time
    // equality check doesn't matter here — we assert on the reload below).
    await waitForLoaded('Loaded title');
    currentDoc = { type: 'doc', __prose: 'loaded prose' };
    setContentSpy.mockClear();

    // A write to this note lands from another window.
    expect(capturedNotesChange).toBeDefined();
    capturedNotesChange!({ id: 'note-1' });

    // The window re-reads and applies the new content (title + editor doc).
    await waitFor(() => expect(readNote).toHaveBeenCalledWith('note-1'));
    await waitForLoaded('Edited elsewhere');
    await waitFor(() =>
      expect(setContentSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({ __prose: 'edited prose' }),
        false, // applied programmatically — not a user edit (Req 2.3)
      ),
    );
  });
});

// --- Pending edits suppress the reload (Req 2.2) ---------------------------

describe('ResourceNoteView — window with pending edits does not reload (Req 2.2)', () => {
  it('skips the reload while a local edit is pending', async () => {
    const readNote = vi
      .fn<(id: string) => Promise<Result<ResourceNote>>>()
      .mockResolvedValue(readOk(note({ prose: 'loaded prose' })));

    installApi({ readNote });
    renderView('?noteId=note-1');

    await waitForLoaded('Loaded title');
    currentDoc = { type: 'doc', __prose: 'loaded prose' };
    // The initial load called readNote once; ignore that for the reload check.
    readNote.mockClear();
    setContentSpy.mockClear();

    // Simulate a user edit: typing in the title arms the autosave debounce,
    // which sets pendingSaveRef = true (Pending_Local_Edits).
    fireEvent.change(screen.getByLabelText('Note title'), {
      target: { value: 'My in-progress edit' },
    });

    // A broadcast for this same note arrives while edits are pending.
    capturedNotesChange!({ id: 'note-1' });

    // Give any (erroneous) async reload a chance to run, then assert it didn't:
    // no re-read, no editor reset. The window's own pending save must win.
    await Promise.resolve();
    expect(readNote).not.toHaveBeenCalled();
    expect(setContentSpy).not.toHaveBeenCalled();
    // The user's in-progress title is untouched.
    expect(screen.getByLabelText('Note title')).toHaveValue('My in-progress edit');
  });
});

// --- Content-equality guard: identical reload is inert (Req 4.1, 4.3) ------

describe('ResourceNoteView — identical content does not reset the editor (Req 4.1, 4.3)', () => {
  it('skips setContent when the reloaded content equals the current content', async () => {
    // Both the initial load and the reload (the echo of this window's own save)
    // return byte-identical content: same title, prose, and highlights.
    const same = note({
      title: 'Loaded title',
      prose: 'loaded prose',
      highlights: [highlight()],
    });
    const readNote = vi
      .fn<(id: string) => Promise<Result<ResourceNote>>>()
      .mockResolvedValue(readOk(same));

    installApi({ readNote });
    renderView('?noteId=note-1');

    await waitForLoaded('Loaded title');
    // Mirror the editor's current prose to what's on disk so the guard's
    // prose comparison (docToMarkdown(currentJson) === note.prose) matches.
    currentDoc = { type: 'doc', __prose: 'loaded prose' };
    readNote.mockClear();
    setContentSpy.mockClear();

    // The echo of our own save arrives: identical on-disk content.
    capturedNotesChange!({ id: 'note-1' });

    // The window re-reads (it's clean) but, finding identical content, must NOT
    // call setContent — that would reset the ProseMirror cursor/selection.
    await waitFor(() => expect(readNote).toHaveBeenCalledWith('note-1'));
    // Let the async hydrate settle, then confirm the editor was never reset.
    await Promise.resolve();
    expect(setContentSpy).not.toHaveBeenCalled();
  });
});

// --- Rename adoption then reload (Req 2.4) ---------------------------------

describe('ResourceNoteView — rename adoption updates the bound id (Req 2.4)', () => {
  it('adopts newId and reloads from it when the bound note is renamed', async () => {
    // Read by id: `old-id` is the pre-rename content, `new-id` the renamed file.
    const readNote = vi
      .fn<(id: string) => Promise<Result<ResourceNote>>>()
      .mockImplementation(async (id: string) =>
        id === 'new-id'
          ? readOk(note({ id: 'new-id', title: 'Renamed', prose: 'renamed prose' }))
          : readOk(note({ id: 'old-id', prose: 'loaded prose' })),
      );

    installApi({ readNote });
    renderView('?noteId=old-id');

    await waitForLoaded('Loaded title');
    currentDoc = { type: 'doc', __prose: 'loaded prose' };
    readNote.mockClear();
    setContentSpy.mockClear();

    // A rename that moved the file: this window is bound to `old-id`.
    capturedNotesChange!({ id: 'new-id', oldId: 'old-id', newId: 'new-id' });

    // It adopts the new id — the reload reads by `new-id`, not `old-id`.
    await waitFor(() => expect(readNote).toHaveBeenCalledWith('new-id'));
    expect(readNote).not.toHaveBeenCalledWith('old-id');
    // And, being clean, it applies the renamed content.
    await waitForLoaded('Renamed');
    await waitFor(() =>
      expect(setContentSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({ __prose: 'renamed prose' }),
        false,
      ),
    );
  });

  it('does not reload on adoption while a local edit is pending, but still adopts the id', async () => {
    const readNote = vi
      .fn<(id: string) => Promise<Result<ResourceNote>>>()
      .mockResolvedValue(readOk(note({ id: 'old-id', prose: 'loaded prose' })));

    installApi({ readNote });
    renderView('?noteId=old-id');

    await waitForLoaded('Loaded title');
    currentDoc = { type: 'doc', __prose: 'loaded prose' };
    readNote.mockClear();
    setContentSpy.mockClear();

    // Arm pending edits, then a rename broadcast arrives.
    fireEvent.change(screen.getByLabelText('Note title'), {
      target: { value: 'Mid-edit title' },
    });
    capturedNotesChange!({ id: 'new-id', oldId: 'old-id', newId: 'new-id' });

    // Adoption happens (id moved) but the reload is skipped — no re-read, no
    // editor reset, and the in-progress title stands.
    await Promise.resolve();
    expect(readNote).not.toHaveBeenCalled();
    expect(setContentSpy).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Note title')).toHaveValue('Mid-edit title');
  });
});
