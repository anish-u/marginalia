import { useState, type FC, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

/**
 * Normalize and validate a user-entered resource URL.
 *
 * Accepts input with or without a scheme: a bare `example.com/page` is treated
 * as `https://example.com/page` (the common case when someone pastes an
 * address). Only http/https are allowed — the browser pane is a `<webview>`
 * pointed at real web content, so `file:`/`javascript:`/etc. are rejected.
 * Returns the normalized absolute URL, or `null` when the input can't be made
 * into a valid http(s) URL.
 */
export function normalizeResourceUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  // Prepend https:// when no scheme is present so `example.com` works.
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

/**
 * The "New Resource Note" dialog shown from the launcher.
 *
 * Collects the resource URL (required, http/https) and an optional title, then
 * hands both to `onCreate`. Previously the launcher opened a hardcoded
 * Wikipedia page; now the user chooses what page the note is about and what to
 * call it. A blank title is allowed — the store substitutes "Untitled note".
 */
export const NewResourceNoteDialog: FC<{
  open: boolean;
  onClose: () => void;
  /** Called with the normalized url and the (possibly empty) title on submit. */
  onCreate: (url: string, title: string) => void;
}> = ({ open, onClose, onCreate }) => {
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setUrl('');
    setTitle('');
    setError(null);
  };

  const close = () => {
    reset();
    onClose();
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const normalized = normalizeResourceUrl(url);
    if (!normalized) {
      setError('Enter a valid web address (http:// or https://).');
      return;
    }
    onCreate(normalized, title.trim());
    reset();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New Resource Note</DialogTitle>
          <DialogDescription>
            Choose the page this note is about and give it a name.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="new-note-url" className="text-sm font-medium">
              Resource URL
            </label>
            <Input
              id="new-note-url"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                if (error) setError(null);
              }}
              placeholder="https://example.com/article"
              aria-invalid={error ? true : undefined}
              autoComplete="off"
              spellCheck={false}
            />
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="new-note-title" className="text-sm font-medium">
              Title <span className="text-muted-foreground">(optional)</span>
            </label>
            <Input
              id="new-note-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Untitled note"
              autoComplete="off"
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit">Create note</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
