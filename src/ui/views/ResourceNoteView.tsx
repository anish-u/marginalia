import { FC, useCallback, useEffect, useRef, useState } from 'react';

import { ChevronDown, ChevronUp, Highlighter, X } from 'lucide-react';
import { useSearchParams } from 'react-router';

import { Button } from '@/components/ui/button';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable';
import { NoteEditor, type NoteEditorHandle } from '@ui/components/NoteEditor';
import { ANNOTATOR_SOURCE } from '@ui/lib/annotator';
import type { WebviewElement } from '@ui/global';
import type { ClipResult, Highlight } from '@shared/highlight';

/** Fallback site loaded when no `?url=` is supplied. */
const DEFAULT_URL = 'https://www.medium.com';

const makeId = (): string =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * A split window: a browser pane and a note editor, separated by a draggable
 * handle. Resizing uses shadcn's `Resizable` (react-resizable-panels).
 *
 * Highlights: the user selects text in the webview and clips it. Each clip is
 * (1) stored as a text-quote anchor (see `@shared/highlight`) and re-painted
 * onto the page via the CSS Custom Highlight API (anchoring/painting runs in
 * the guest page — see `@ui/lib/annotator`), and (2) inserted into the note as
 * a clickable `highlightQuote` block (see `NoteEditor`) at the cursor, so the
 * user can write a paragraph, drop in a clip, then keep writing below it.
 * Clicking a clip in the note scrolls the webview back to it. State is
 * in-memory for now — persistence comes with note saving.
 */
export const ResourceNoteView: FC = () => {
  const [params] = useSearchParams();
  const url = params.get('url') ?? DEFAULT_URL;

  const webviewRef = useRef<WebviewElement | null>(null);
  const editorRef = useRef<NoteEditorHandle | null>(null);
  const [ready, setReady] = useState(false);

  const [dragging, setDragging] = useState(false);
  const [title, setTitle] = useState('');
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [highlightsExpanded, setHighlightsExpanded] = useState(false);

  useEffect(() => {
    document.title = title.trim() === '' ? 'Resource Note' : title;
  }, [title]);

  // Inject the annotator into the guest page every time it (re)loads. `ready`
  // gates the Clip button and drives the initial paint.
  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;

    const onDomReady = () => {
      webview
        .executeJavaScript(ANNOTATOR_SOURCE)
        .then(() => setReady(true))
        .catch(() => setReady(false));
    };

    // `dom-ready` isn't in the DOM event map; the webview is still an
    // EventTarget so addEventListener works at runtime.
    webview.addEventListener('dom-ready', onDomReady as EventListener);
    return () => {
      webview.removeEventListener('dom-ready', onDomReady as EventListener);
    };
  }, []);

  // Re-paint whenever the highlight set changes (or the page becomes ready).
  const paint = useCallback((list: Highlight[]) => {
    const webview = webviewRef.current;
    if (!webview) return;
    webview
      .executeJavaScript(
        `window.__marginalia && window.__marginalia.paint(${JSON.stringify(list)})`,
      )
      .catch(() => {
        /* guest not ready yet; next dom-ready will repaint */
      });
  }, []);

  useEffect(() => {
    if (ready) paint(highlights);
  }, [ready, highlights, paint]);

  const scrollToHighlight = useCallback((id: string) => {
    const webview = webviewRef.current;
    if (!webview) return;
    webview
      .executeJavaScript(
        `window.__marginalia && window.__marginalia.scrollTo(${JSON.stringify(id)})`,
      )
      .catch(() => {
        /* ignore */
      });
  }, []);

  const clip = useCallback(async () => {
    const webview = webviewRef.current;
    if (!webview) return;
    let result: ClipResult = null;
    try {
      result = (await webview.executeJavaScript(
        'window.__marginalia && window.__marginalia.clip()',
      )) as ClipResult;
    } catch {
      return;
    }
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
    <ResizablePanelGroup
      orientation="horizontal"
      className="h-full w-full"
      onLayoutChange={() => setDragging(true)}
      onLayoutChanged={() => {
        window.setTimeout(() => setDragging(false), 0);
      }}
    >
      {/* Browser pane */}
      <ResizablePanel defaultSize="55%" minSize="30%">
        <div className="relative h-full w-full">
          <webview
            ref={webviewRef as React.Ref<HTMLElement>}
            src={url}
            className="h-full w-full"
          />
          {dragging && <div className="absolute inset-0 cursor-col-resize" />}
        </div>
      </ResizablePanel>

      <ResizableHandle withHandle />

      {/* Note pane: title → notes → highlights (bottom, collapsible). */}
      <ResizablePanel defaultSize="45%" minSize="20%">
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
            >
              <Highlighter />
              Clip
            </Button>
          </div>

          {/* Notes editor — fills the space between title and highlights. */}
          <div className="flex min-h-0 flex-1 flex-col px-5">
            <NoteEditor
              ref={editorRef}
              onActivateHighlight={scrollToHighlight}
              onHighlightIdsChange={handleHighlightIdsChange}
            />
          </div>

          {/* Highlights — pinned to the bottom, collapsed by default. */}
          {highlights.length > 0 && (
            <section className="shrink-0 border-t">
              <button
                type="button"
                onClick={() => setHighlightsExpanded((v) => !v)}
                className="flex w-full items-center justify-between px-5 py-2 text-xs font-medium text-muted-foreground hover:text-foreground"
                aria-expanded={highlightsExpanded}
              >
                <span>
                  {highlights.length} highlight
                  {highlights.length === 1 ? '' : 's'}
                </span>
                {highlightsExpanded ? (
                  <ChevronDown className="size-4" />
                ) : (
                  <ChevronUp className="size-4" />
                )}
              </button>

              {highlightsExpanded && (
                <ul className="max-h-56 overflow-auto border-t">
                  {highlights.map((h) => (
                    <li
                      key={h.id}
                      className="group flex items-start gap-2 border-b px-5 py-2 last:border-b-0"
                    >
                      <button
                        type="button"
                        onClick={() => scrollToHighlight(h.id)}
                        className="flex-1 truncate border-l-2 border-yellow-400 pl-2 text-left text-sm leading-snug text-muted-foreground hover:text-foreground"
                        title="Jump to highlight"
                      >
                        {h.text}
                      </button>
                      <button
                        type="button"
                        onClick={() => removeHighlight(h.id)}
                        className="mt-0.5 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-accent group-hover:opacity-100"
                        title="Remove highlight"
                        aria-label="Remove highlight"
                      >
                        <X className="size-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </main>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
};
