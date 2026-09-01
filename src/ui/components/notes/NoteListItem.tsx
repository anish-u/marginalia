import { useEffect, useRef, useState, type FC, type FormEvent } from 'react';

import { Check, Globe, Pencil, Trash2, X } from 'lucide-react';

import { Input } from '@/components/ui/input';
import type { ResourceNoteSummary } from '@shared/resource-note';

/** Placeholder shown when a note has no meaningful title (Req 3.5). */
export const DEFAULT_TITLE_PLACEHOLDER = 'Untitled note';

/** Format an epoch-ms timestamp as a short, human "last modified" label. */
function formatModified(ms: number): string {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/**
 * A note rendered as a card in the notes grid.
 *
 * The whole card is a clickable surface that opens the note; Rename and Delete
 * actions sit in the top-right, revealed on hover/focus. Rename swaps the title
 * for an inline field (Enter/✓ saves, Esc/✕ cancels). Even though the store
 * substitutes a default title on write (Req 5.7), the card independently shows
 * a placeholder for empty/whitespace titles (Req 3.5).
 *
 * Props are unchanged from the previous list row (`note`, `onOpen`, `onRename`,
 * `onDelete`) so the parent list didn't need rewiring — only the layout is now
 * a card rather than a full-width row.
 */
export const NoteListItem: FC<{
  note: ResourceNoteSummary;
  onOpen: () => void;
  onRename: (title: string) => void;
  onDelete: () => void;
}> = ({ note, onOpen, onRename, onDelete }) => {
  const hasTitle = note.title.trim().length > 0;
  const displayTitle = hasTitle ? note.title : DEFAULT_TITLE_PLACEHOLDER;

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.title);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editing) {
      setDraft(note.title);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [editing, note.title]);

  const commitRename = (e?: FormEvent) => {
    e?.preventDefault();
    const next = draft.trim();
    setEditing(false);
    if (next !== note.title.trim()) onRename(next);
  };

  const cancelRename = () => {
    setEditing(false);
    setDraft(note.title);
  };

  return (
    <div className="group relative flex h-full flex-col rounded-lg border bg-card p-4 transition-colors hover:border-ring/60 hover:bg-accent/40">
      {/* Row actions (rename/delete), top-right, revealed on hover/focus. */}
      {!editing && (
        <div className="absolute top-2 right-2 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            title="Rename note"
            aria-label={`Rename ${displayTitle}`}
          >
            <Pencil className="size-4" />
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="rounded p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            title="Delete note"
            aria-label={`Delete ${displayTitle}`}
          >
            <Trash2 className="size-4" />
          </button>
        </div>
      )}

      {/* Type indicator. Only website-link notes exist today (Req 3.4). */}
      <span
        className="mb-3 flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
        aria-label="Website link note"
        title="Website link"
      >
        <Globe className="size-4" />
      </span>

      {editing ? (
        <form onSubmit={commitRename} className="flex items-center gap-1">
          <Input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                cancelRename();
              }
            }}
            placeholder={DEFAULT_TITLE_PLACEHOLDER}
            aria-label="Note title"
            className="h-8"
          />
          <button
            type="submit"
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            title="Save title"
            aria-label="Save title"
          >
            <Check className="size-4" />
          </button>
          <button
            type="button"
            onClick={cancelRename}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            title="Cancel"
            aria-label="Cancel rename"
          >
            <X className="size-4" />
          </button>
        </form>
      ) : (
        // Clicking the card body (title/date area) opens the note. Rendered as a
        // button spanning the remaining card area for keyboard access; the
        // absolutely-positioned actions above sit outside it (valid HTML — no
        // nested buttons).
        <button
          type="button"
          onClick={onOpen}
          className="flex flex-1 flex-col items-start gap-1 text-left focus-visible:outline-none"
        >
          <span
            className={
              'line-clamp-2 text-sm ' +
              (hasTitle ? 'font-medium' : 'italic text-muted-foreground')
            }
          >
            {displayTitle}
          </span>
          <span className="mt-auto pt-2 text-xs text-muted-foreground">
            {formatModified(note.modifiedAt)}
          </span>
        </button>
      )}
    </div>
  );
};
