import { useState, type FC } from 'react';

import { ChevronDown, ChevronUp, X } from 'lucide-react';

import type { Highlight } from '@shared/highlight';

/**
 * The collapsible highlights index pinned to the bottom of the note pane.
 *
 * Lists every clip in the note; clicking one scrolls the webview back to it
 * (`onActivate`), and the ✕ removes it (`onRemove`). Renders nothing when there
 * are no highlights. Collapsed by default so it stays out of the way.
 *
 * `unresolvedIds` are highlights whose text-quote anchor couldn't be located on
 * the current resource page (e.g. after a reload or on a note restored into a
 * changed page). Those rows get a muted "not found on page" badge but stay
 * listed, clickable, and removable — nothing is dropped (Req 6.6).
 */
export const HighlightsIndex: FC<{
  highlights: Highlight[];
  onActivate: (id: string) => void;
  onRemove: (id: string) => void;
  unresolvedIds?: Set<string>;
}> = ({ highlights, onActivate, onRemove, unresolvedIds }) => {
  const [expanded, setExpanded] = useState(false);

  if (highlights.length === 0) return null;

  return (
    <section className="shrink-0 border-t">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between px-5 py-2 text-xs font-medium text-muted-foreground hover:text-foreground"
        aria-expanded={expanded}
      >
        <span>
          {highlights.length} highlight
          {highlights.length === 1 ? '' : 's'}
        </span>
        {expanded ? (
          <ChevronDown className="size-4" />
        ) : (
          <ChevronUp className="size-4" />
        )}
      </button>

      {expanded && (
        <ul className="max-h-56 overflow-auto border-t">
          {highlights.map((h) => {
            const notFound = unresolvedIds?.has(h.id) ?? false;
            return (
            <li
              key={h.id}
              className="group flex items-start gap-2 border-b px-5 py-2 last:border-b-0"
            >
              <div className="min-w-0 flex-1">
                <button
                  type="button"
                  onClick={() => onActivate(h.id)}
                  className="w-full truncate border-l-2 border-marginalia pl-2 text-left text-sm leading-snug text-muted-foreground hover:text-foreground"
                  title="Jump to highlight"
                >
                  {h.text}
                </button>
                {notFound && (
                  // Muted, non-destructive indicator: the clip is retained but
                  // its anchor isn't on the current page (Req 6.6). `role=status`
                  // keeps it discoverable to screen readers.
                  <span
                    role="status"
                    className="mt-1 ml-2 inline-block rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
                  >
                    Not found on page
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={() => onRemove(h.id)}
                className="mt-0.5 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-accent group-hover:opacity-100"
                title="Remove highlight"
                aria-label="Remove highlight"
              >
                <X className="size-3.5" />
              </button>
            </li>
            );
          })}
        </ul>
      )}
    </section>
  );
};
