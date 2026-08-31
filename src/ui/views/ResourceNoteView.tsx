import { FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { FileText, Globe, Highlighter } from 'lucide-react';
import { useSearchParams } from 'react-router';
import type { PanelImperativeHandle } from 'react-resizable-panels';

import { Button } from '@/components/ui/button';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable';
import { CollapsedRail } from '@ui/components/resource-note/CollapsedRail';
import { HighlightsIndex } from '@ui/components/resource-note/HighlightsIndex';
import { NoteEditor, type NoteEditorHandle } from '@ui/components/resource-note/NoteEditor';
import { useAnnotator } from '@ui/hooks/use-annotator';
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
  const url = params.get('url') ?? DEFAULT_URL;

  // Webview ↔ guest-annotator glue: inject, paint, scroll, clip, ready state.
  const { webviewRef, ready, paint, scrollTo, clip: clipSelection } =
    useAnnotator();
  const editorRef = useRef<NoteEditorHandle | null>(null);

  const [dragging, setDragging] = useState(false);
  const [title, setTitle] = useState('');
  const [highlights, setHighlights] = useState<Highlight[]>([]);

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
  useEffect(() => {
    if (ready) paint(highlights);
  }, [ready, highlights, paint]);

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
          <div className="relative h-full w-full">
            <webview
              ref={webviewRef as React.Ref<HTMLElement>}
              src={url}
              className="h-full w-full"
            />
            {dragging && <div className="absolute inset-0 cursor-col-resize" />}
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
            {/* Title + clip action */}
            <div className="flex items-center gap-2 px-5 pt-5 pb-2">
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Title"
                className="min-w-0 flex-1 border-0 bg-transparent text-2xl font-semibold tracking-tight outline-none placeholder:text-muted-foreground"
              />
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

            {/* Notes editor — fills the space between title and highlights. */}
            <div className="flex min-h-0 flex-1 flex-col px-5">
              <NoteEditor
                ref={editorRef}
                onActivateHighlight={scrollTo}
                onHighlightIdsChange={handleHighlightIdsChange}
              />
            </div>

            {/* Highlights index — pinned to the bottom, collapsed by default. */}
            <HighlightsIndex
              highlights={highlights}
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
