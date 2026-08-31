import { FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  ArrowLeft,
  ArrowRight,
  FileText,
  Globe,
  Highlighter,
  RotateCw,
} from 'lucide-react';
import { useSearchParams } from 'react-router';
import type { PanelImperativeHandle } from 'react-resizable-panels';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable';
import { CollapsedRail } from '@ui/components/resource-note/CollapsedRail';
import { HighlightsIndex } from '@ui/components/resource-note/HighlightsIndex';
import { NoteEditor, type NoteEditorHandle } from '@ui/components/resource-note/NoteEditor';
import { useAnnotator } from '@ui/hooks/use-annotator';
import { useWebviewNav } from '@ui/hooks/use-webview-nav';
import { docToMarkdown, markdownToDoc } from '@ui/lib/note-markdown';
import type { Highlight } from '@shared/highlight';

/** Fallback site loaded when no `?url=` is supplied. */
const DEFAULT_URL = 'https://www.medium.com';

/** Below this width (% of the group) a pane snaps shut to its collapsed rail. */
const MIN_PANE_SIZE = '20%';

const makeId = (): string =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * A split window: a browser pane and a note editor, separated by a draggable
 * handle. Resizing uses shadcn's `Resizable` (react-resizable-panels).
 *
 * Highlights: the user selects text in the webview and clips it. Each clip is
 * (1) stored as a text-quote anchor (see `@shared/highlight`) and re-painted
 * onto the page via the CSS Custom Highlight API (the webview glue lives in the
 * `useAnnotator` hook; anchoring/painting itself runs in the guest page — see
 * `@ui/lib/annotator`), and (2) inserted into the note as a clickable
 * `highlightQuote` block (see `NoteEditor`) at the cursor, so the user can write
 * a paragraph, drop in a clip, then keep writing below it. Clicking a clip in
 * the note scrolls the webview back to it. State is in-memory for now —
 * persistence comes with note saving.
 */
export const ResourceNoteView: FC = () => {
  const [params] = useSearchParams();
  // `noteId` opens an existing note (load its resource url + prose); `url`
  // seeds a fresh note. When opening by id the resource url comes from the
  // loaded note, so `?url=` may be absent.
  const noteId = params.get('noteId');
  const urlParam = params.get('url');
  // Optional initial title chosen in the launcher's "New Resource Note" dialog.
  // Only meaningful for a fresh note; an existing note's title comes from the
  // loaded file (the load effect overwrites this).
  const titleParam = params.get('title');

  // Webview ↔ guest-annotator glue: inject, paint, scroll, clip, ready state.
  const { webviewRef, ready, paint, scrollTo, clip: clipSelection } =
    useAnnotator();
  const editorRef = useRef<NoteEditorHandle | null>(null);

  const [dragging, setDragging] = useState(false);
  // Seed the title from the launcher dialog (fresh note); a loaded note
  // overwrites it once `readNote` resolves.
  const [title, setTitle] = useState(() =>
    !noteId && titleParam ? titleParam : '',
  );
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  // Ids of highlights whose text-quote anchor couldn't be located on the live
  // page after the last paint. They stay in `highlights` (and the note prose) —
  // this set only drives the "not found on page" indicator (Req 6.6).
  const [unresolvedIds, setUnresolvedIds] = useState<Set<string>>(
    () => new Set(),
  );

  // The resource URL that drives the <webview src>. For a fresh note it's the
  // `?url=` param (or the default); for a loaded note it's overwritten with the
  // note's stored resource url once `readNote` resolves.
  const [url, setUrl] = useState(urlParam ?? DEFAULT_URL);

  // Webview navigation state + controls (back/forward/reload + address bar).
  const {
    currentUrl,
    canGoBack,
    canGoForward,
    loading: webviewLoading,
    goBack,
    goForward,
    reload,
    navigate,
  } = useWebviewNav(webviewRef, url);
  // The address-bar draft: seeded from the live URL, editable while typing.
  const [addressDraft, setAddressDraft] = useState(url);
  const [addressFocused, setAddressFocused] = useState(false);
  // Reflect the live URL into the address bar unless the user is editing it.
  useEffect(() => {
    if (!addressFocused) setAddressDraft(currentUrl);
  }, [currentUrl, addressFocused]);

  // Note identity + persisted timestamps. `id` is null until a fresh note is
  // first saved (then `makeId()` assigns it once and it becomes the filename
  // stem); an existing note carries its id from load. `createdAt`/`modifiedAt`
  // are whatever the store last returned. These live in refs (not state)
  // because they're read inside the debounced save without needing to re-run
  // effects when they change.
  const noteIdRef = useRef<string | null>(noteId);
  const createdAtRef = useRef<number | null>(null);
  const modifiedAtRef = useRef<number | null>(null);

  // Guards the load so a fresh note (or a note being hydrated) doesn't autosave
  // before/while it's being populated. Autosave only runs after load settles.
  const loadedRef = useRef(false);

  // Subtle save status for the header, so a failed write (e.g. no active vault)
  // is visible without crashing or losing in-memory state.
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>(
    'idle',
  );

  // Collapse handling: each pane is collapsible, and when a pane collapses we
  // swap its content for a thin rail. We hold imperative refs to expand a pane
  // back when its rail is clicked.
  const browserPanelRef = useRef<PanelImperativeHandle | null>(null);
  const notePanelRef = useRef<PanelImperativeHandle | null>(null);
  const [browserCollapsed, setBrowserCollapsed] = useState(false);
  const [noteCollapsed, setNoteCollapsed] = useState(false);

  // Label the browser rail with the site's hostname; fall back to "Resource".
  const siteLabel = useMemo(() => {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return 'Resource';
    }
  }, [url]);

  useEffect(() => {
    document.title = title.trim() === '' ? 'Resource Note' : title;
  }, [title]);

  // Re-paint whenever the highlight set changes (or the page becomes ready).
  // Loaded highlights flow through this same effect, so restoring a note re-
  // anchors its clips on the live page and clicking one scrolls to it (Req 6.5).
  // `paint` reports which ids it located; the rest couldn't be re-anchored, so
  // we flag them in the index without dropping them from the note (Req 6.6).
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    void (async () => {
      const painted = await paint(highlights);
      if (cancelled) return;
      const paintedSet = new Set(painted);
      setUnresolvedIds(
        new Set(
          highlights.filter((h) => !paintedSet.has(h.id)).map((h) => h.id),
        ),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, highlights, paint]);

  // --- Load an existing note on mount (Req 6.3) -------------------------------
  // If `noteId` is present, pull the note from the active vault: set the title,
  // drive the <webview src> from the stored resource url, hydrate the editor
  // from the prose Markdown, and restore the highlight anchors. On failure we
  // fall back to an empty fresh note rather than crashing.
  useEffect(() => {
    if (!noteId) {
      // Fresh note: nothing to load; enable autosave immediately.
      loadedRef.current = true;
      return;
    }

    let cancelled = false;
    void (async () => {
      const result = await window.marginalia.readNote(noteId);
      if (cancelled) return;

      if (result.ok) {
        const note = result.value;
        noteIdRef.current = note.id;
        createdAtRef.current = note.createdAt;
        modifiedAtRef.current = note.modifiedAt;
        setTitle(note.title);
        // Only website-link resources carry a url today; other (reserved)
        // variants leave the webview on its default.
        if (note.resource.type === 'website-link') setUrl(note.resource.url);
        setHighlights(note.content.highlights);
        // Hydrate the editor. `emitUpdate: false` so this programmatic load
        // isn't mistaken for a user edit (which would trigger an autosave).
        editorRef.current?.setContent(
          markdownToDoc(note.content.prose, note.content.highlights),
          false,
        );
        setSaveState('saved');
      } else {
        // Couldn't read it (missing / unreadable / no vault). Keep the empty
        // note so the user can still work; surface the failure subtly.
        console.warn(
          `Failed to load note ${noteId}: ${result.error.code} — ${result.error.message}`,
        );
        setSaveState('error');
      }

      // Whether load succeeded or failed, autosave may now run for edits the
      // user makes from here.
      loadedRef.current = true;
    })();

    return () => {
      cancelled = true;
    };
    // Load runs once for the id this window was opened with.
  }, [noteId]);

  // --- Adopt a new id if this note is renamed elsewhere -----------------------
  // If the note open in this window is renamed from the launcher, its file moves
  // to a new id. The main process broadcasts NotesChanged with { oldId, newId };
  // when oldId matches the id we're currently bound to, adopt newId so our next
  // autosave writes the renamed file instead of recreating the old one. We also
  // sync the title to match. Guarded by a ref check so unrelated broadcasts and
  // our own renames don't disturb this window.
  useEffect(() => {
    return window.marginalia.onNotesChanged((rename) => {
      if (!rename) return;
      if (noteIdRef.current !== rename.oldId) return;
      noteIdRef.current = rename.newId;
      // Re-read so the heading reflects the new title without marking dirty.
      void (async () => {
        const result = await window.marginalia.readNote(rename.newId);
        if (result.ok) setTitle(result.value.title);
      })();
    });
  }, []);

  // --- Debounced autosave (~800ms idle, Req 5.1/5.4) --------------------------
  // Title edits, editor changes, and highlight-set changes mark the note dirty;
  // after ~800ms of no further changes we persist. A fresh note generates its
  // id once, on first save (reusing `makeId`); the id becomes the filename
  // stem. The store owns timestamps — we store whatever `writeNote` returns.
  // The write is async in the main process, so it never blocks typing.
  const AUTOSAVE_DELAY_MS = 800;
  const saveTimerRef = useRef<number | null>(null);
  // A monotonically bumped counter: changing any tracked input bumps it, which
  // (re)arms the debounce. Kept in state so the effect below re-runs on change.
  const [dirtyTick, setDirtyTick] = useState(0);
  const markDirty = useCallback(() => setDirtyTick((n) => n + 1), []);

  const save = useCallback(async () => {
    const editorJson = editorRef.current?.getJSON();
    if (!editorJson) return; // editor not mounted yet

    // Assign an id once for a fresh note; it becomes the filename stem. Derive
    // it from the title so the on-disk file is recognizable (e.g.
    // `my-research-notes.md`). If there's no active vault yet, allocateNoteId
    // returns null — fall back to an opaque id so the note still has a stable
    // identity in memory (the write will then fail with no-vault, which is
    // handled below). Once assigned, the id is stable for the note's lifetime.
    if (!noteIdRef.current) {
      const allocated = await window.marginalia.allocateNoteId(title);
      noteIdRef.current = allocated ?? makeId();
    }

    setSaveState('saving');
    const result = await window.marginalia.writeNote({
      id: noteIdRef.current,
      title,
      resource: { type: 'website-link', url },
      content: {
        prose: docToMarkdown(editorJson),
        highlights,
      },
    });

    if (result.ok) {
      createdAtRef.current = result.value.createdAt;
      modifiedAtRef.current = result.value.modifiedAt;
      setSaveState('saved');
    } else {
      // e.g. `no-vault`: keep in-memory state intact and surface the failure
      // without crashing. The next edit will retry.
      console.warn(
        `Autosave failed: ${result.error.code} — ${result.error.message}`,
      );
      setSaveState('error');
    }
  }, [title, url, highlights]);

  // Arm the debounce whenever a tracked input changes (after load settles).
  useEffect(() => {
    if (!loadedRef.current) return; // don't autosave during initial load
    if (dirtyTick === 0) return; // no user change yet

    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      void save();
    }, AUTOSAVE_DELAY_MS);

    return () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, [dirtyTick, save]);

  // Title and highlight-set changes mark the note dirty. (Editor changes route
  // through the NoteEditor `onUpdate` prop below.) Skipped until load settles
  // so hydrating a loaded note's title/highlights doesn't trigger a save.
  useEffect(() => {
    if (!loadedRef.current) return;
    markDirty();
  }, [title, highlights, markDirty]);

  const clip = useCallback(async () => {
    const result = await clipSelection();
    if (!result) return;

    const highlight: Highlight = {
      ...result,
      id: makeId(),
      createdAt: Date.now(),
    };
    setHighlights((prev) => [...prev, highlight]);

    // Drop the clip into the note as its own clickable block at the cursor.
    editorRef.current?.insertHighlight({
      id: highlight.id,
      text: highlight.text,
      url: highlight.url,
    });
  }, [clipSelection]);

  // Always clear the drag overlay when the pointer is released, even if no
  // layout change fired (e.g. the user pressed the separator without moving).
  // Otherwise the transparent overlay could stay up and block the webview.
  useEffect(() => {
    const clear = () => setDragging(false);
    window.addEventListener('pointerup', clear);
    window.addEventListener('pointercancel', clear);
    return () => {
      window.removeEventListener('pointerup', clear);
      window.removeEventListener('pointercancel', clear);
    };
  }, []);

  // Cmd/Ctrl+Shift+H clips the current selection.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        e.key.toLowerCase() === 'h'
      ) {
        e.preventDefault();
        void clip();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [clip]);

  const removeHighlight = useCallback((id: string) => {
    setHighlights((prev) => prev.filter((h) => h.id !== id));
    // Also drop it from the note body so the index and the doc stay in sync.
    editorRef.current?.removeHighlight(id);
  }, []);

  // When the editor reports which highlight blocks remain (e.g. after the user
  // backspaces one out), prune any that are gone. The repaint effect then
  // clears their on-page paint too.
  const handleHighlightIdsChange = useCallback((ids: string[]) => {
    const present = new Set(ids);
    setHighlights((prev) => {
      if (prev.every((h) => present.has(h.id))) return prev; // nothing removed
      return prev.filter((h) => present.has(h.id));
    });
  }, []);

  return (
    <div className="flex h-full w-full">
      {/* Left rail: shown when the browser pane is collapsed. */}
      {browserCollapsed && (
        <CollapsedRail
          label={siteLabel}
          icon={<Globe className="size-4" />}
          side="left"
          onExpand={() => browserPanelRef.current?.expand()}
        />
      )}

      <ResizablePanelGroup
        orientation="horizontal"
        className="h-full min-w-0 flex-1"
        // Cover the <webview> the instant a drag starts on the separator —
        // before react-resizable-panels calls setPointerCapture. The webview is
        // an out-of-process frame that intercepts the pointer stream on the host
        // document; if the pointer reaches it mid-drag, setPointerCapture throws
        // InvalidStateError. The `dragging` overlay (below) keeps the pointer on
        // the host document for the whole drag. Capture phase so we run first.
        onPointerDownCapture={(e) => {
          if ((e.target as HTMLElement)?.closest('[data-separator]')) {
            setDragging(true);
          }
        }}
        onLayoutChange={() => setDragging(true)}
        onLayoutChanged={() => {
          window.setTimeout(() => setDragging(false), 0);
        }}
      >
        {/* Browser pane. Collapses to a rail when dragged below MIN_PANE_SIZE. */}
        <ResizablePanel
          panelRef={browserPanelRef}
          defaultSize="55%"
          minSize={MIN_PANE_SIZE}
          collapsible
          collapsedSize="0%"
          onResize={(size) => setBrowserCollapsed(size.asPercentage === 0)}
        >
          <div className="flex h-full w-full flex-col">
            {/* Navigation toolbar: back / forward / reload + address bar. */}
            <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1.5">
              <Button
                size="icon"
                variant="ghost"
                className="size-8"
                disabled={!canGoBack}
                onClick={goBack}
                aria-label="Go back"
                title="Back"
              >
                <ArrowLeft className="size-4" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="size-8"
                disabled={!canGoForward}
                onClick={goForward}
                aria-label="Go forward"
                title="Forward"
              >
                <ArrowRight className="size-4" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="size-8"
                onClick={reload}
                aria-label="Reload"
                title="Reload"
              >
                <RotateCw
                  className={'size-4 ' + (webviewLoading ? 'animate-spin' : '')}
                />
              </Button>
              <form
                className="min-w-0 flex-1"
                onSubmit={(e) => {
                  e.preventDefault();
                  navigate(addressDraft);
                  (e.currentTarget.querySelector('input') as HTMLInputElement)?.blur();
                }}
              >
                <Input
                  value={addressDraft}
                  onChange={(e) => setAddressDraft(e.target.value)}
                  onFocus={(e) => {
                    setAddressFocused(true);
                    e.target.select();
                  }}
                  onBlur={() => setAddressFocused(false)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      setAddressDraft(currentUrl);
                      e.currentTarget.blur();
                    }
                  }}
                  placeholder="Enter a web address"
                  aria-label="Address"
                  spellCheck={false}
                  autoComplete="off"
                  className="h-8 text-xs"
                />
              </form>
            </div>

            <div className="relative min-h-0 flex-1">
              <webview
                ref={webviewRef as React.Ref<HTMLElement>}
                src={url}
                className="h-full w-full"
              />
              {dragging && (
                <div className="absolute inset-0 cursor-col-resize" />
              )}
            </div>
          </div>
        </ResizablePanel>

        {/* Hide the drag handle when either side is fully collapsed — the rail
            owns re-expansion at that point. */}
        {!browserCollapsed && !noteCollapsed && <ResizableHandle withHandle />}

        {/* Note pane: title → notes → highlights (bottom, collapsible). */}
        <ResizablePanel
          panelRef={notePanelRef}
          defaultSize="45%"
          minSize={MIN_PANE_SIZE}
          collapsible
          collapsedSize="0%"
          onResize={(size) => setNoteCollapsed(size.asPercentage === 0)}
        >
          <main className="flex h-full flex-col">
            {/* Action toolbar: save status + clip. The title is no longer a
                labelled input — it's an editable document heading below. */}
            <div className="flex items-center justify-end gap-2 px-5 pt-3 pb-1">
              {/* Subtle autosave status. Never blocks the UI; a failed write
                  (e.g. no active vault) shows here without losing state. */}
              <span
                className="mr-auto text-xs text-muted-foreground"
                title={
                  saveState === 'error'
                    ? "Couldn't save — check that a vault is open"
                    : undefined
                }
              >
                {saveState === 'saving'
                  ? 'Saving…'
                  : saveState === 'saved'
                    ? 'Saved'
                    : saveState === 'error'
                      ? 'Not saved'
                      : ''}
              </span>
              <Button
                size="sm"
                variant="secondary"
                disabled={!ready}
                onClick={() => void clip()}
                title="Clip selection (⌘⇧H)"
                className="bg-accent text-accent-foreground hover:bg-accent/80"
              >
                <Highlighter />
                Clip
              </Button>
            </div>

            {/* Editable title, styled as the note's document heading. It reads
                as an <h1> but stays directly editable (Enter jumps focus into
                the body rather than inserting a newline). */}
            <div className="px-5 pb-2">
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    editorRef.current?.focus();
                  }
                }}
                placeholder="Untitled note"
                aria-label="Note title"
                className="w-full border-0 bg-transparent text-3xl font-bold tracking-tight outline-none placeholder:text-muted-foreground/60"
              />
            </div>

            {/* Notes editor — fills the space between title and highlights. */}
            <div className="flex min-h-0 flex-1 flex-col px-5">
              <NoteEditor
                ref={editorRef}
                onActivateHighlight={scrollTo}
                onHighlightIdsChange={handleHighlightIdsChange}
                onUpdate={() => {
                  // Editor edits mark the note dirty (debounced autosave). The
                  // guard skips programmatic hydration, which is dispatched with
                  // `emitUpdate: false` and so never reaches here anyway.
                  if (loadedRef.current) markDirty();
                }}
              />
            </div>

            {/* Highlights index — pinned to the bottom, collapsed by default. */}
            <HighlightsIndex
              highlights={highlights}
              unresolvedIds={unresolvedIds}
              onActivate={scrollTo}
              onRemove={removeHighlight}
            />
          </main>
        </ResizablePanel>
      </ResizablePanelGroup>

      {/* Right rail: shown when the note pane is collapsed. */}
      {noteCollapsed && (
        <CollapsedRail
          label="Note"
          icon={<FileText className="size-4" />}
          side="right"
          onExpand={() => notePanelRef.current?.expand()}
        />
      )}
    </div>
  );
};
