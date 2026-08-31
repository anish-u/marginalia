import { FC, useEffect, useState } from 'react';

/**
 * The note editor shown in a note window (loaded at the `#note` route).
 *
 * This is deliberately a different UI from the launcher: a title field and a
 * free-form body. State is local for now — persistence can be wired through the
 * preload bridge later. The window title mirrors the note title so multiple
 * open notes are distinguishable in the OS window list.
 */
export const NoteView: FC = () => {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');

  useEffect(() => {
    document.title = title.trim() === '' ? 'New Note' : title;
  }, [title]);

  return (
    <main className="flex h-screen flex-col gap-3 p-5">
      <input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Title"
        className="border-0 bg-transparent text-2xl font-semibold tracking-tight outline-none placeholder:text-muted-foreground"
      />
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Start writing…"
        className="flex-1 resize-none border-0 bg-transparent text-base leading-relaxed outline-none placeholder:text-muted-foreground"
      />
    </main>
  );
};
