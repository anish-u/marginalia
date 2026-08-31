import { useState, type FC } from 'react';

import { ChevronDown, ChevronUp, X } from 'lucide-react';

import type { Highlight } from '@shared/highlight';

/**
 * The collapsible highlights index pinned to the bottom of the note pane.
 *
 * Lists every clip in the note; clicking one scrolls the webview back to it
 * (`onActivate`), and the ✕ removes it (`onRemove`). Renders nothing when there
 * are no highlights. Collapsed by default so it stays out of the way.
 */
export const HighlightsIndex: FC<{
  highlights: Highlight[];
  onActivate: (id: string) => void;
  onRemove: (id: string) => void;
}> = ({ highlights, onActivate, onRemove }) => {
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
          {highlights.map((h) => (
            <li
              key={h.id}
              className="group flex items-start gap-2 border-b px-5 py-2 last:border-b-0"
            >
              <button
                type="button"
                onClick={() => onActivate(h.id)}
                className="flex-1 truncate border-l-2 border-marginalia pl-2 text-left text-sm leading-snug text-muted-foreground hover:text-foreground"
                title="Jump to highlight"
              >
                {h.text}
              </button>
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
          ))}
        </ul>
      )}
    </section>
  );
};
