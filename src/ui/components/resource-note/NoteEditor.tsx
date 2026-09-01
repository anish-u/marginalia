import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from 'react';

import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import type { JSONContent } from '@tiptap/core';
import { StarterKit } from '@tiptap/starter-kit';

import { FormattingMenu } from '@ui/components/resource-note/FormattingMenu';
import {
  HighlightQuote,
  type HighlightActivate,
  type HighlightQuoteAttrs,
} from '@ui/components/resource-note/highlight-quote-node';

/** Imperative API the parent uses to drive the editor. */
export interface NoteEditorHandle {
  /** Insert a highlight-quote block at the current cursor position. */
  insertHighlight: (attrs: HighlightQuoteAttrs) => void;
  /** Remove the highlight-quote block with the given id from the document. */
  removeHighlight: (id: string) => void;
  /** Move focus into the editor. */
  focus: () => void;
  /**
   * Replace the whole document with the given Tiptap JSON. Used to hydrate the
   * editor when loading an existing note. Passing `false` for `emitUpdate`
   * avoids firing `onUpdate` for the programmatic load (so it isn't mistaken
   * for a user edit that would trigger autosave).
   */
  setContent: (content: JSONContent, emitUpdate?: boolean) => void;
  /** Current document as Tiptap JSON, for serialization (docToMarkdown). */
  getJSON: () => JSONContent | null;
}

interface NoteEditorProps {
  /** Called when a highlight-quote block in the note is clicked. */
  onActivateHighlight: HighlightActivate;
  /**
   * Called whenever the set of highlight-quote blocks present in the document
   * changes (e.g. the user deletes one with backspace). Receives the ids still
   * in the note so the parent can prune removed highlights and re-paint.
   */
  onHighlightIdsChange?: (ids: string[]) => void;
  /**
   * Called on every editor document change (Tiptap's `onUpdate`). The parent
   * uses this to mark the note dirty and schedule a debounced autosave. Not
   * fired for programmatic hydration via `setContent(content, false)`.
   */
  onUpdate?: () => void;
}

/** Collect the ids of every highlight-quote block currently in the document. */
const collectHighlightIds = (editor: Editor): string[] => {
  const ids: string[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'highlightQuote' && node.attrs.id) {
      ids.push(node.attrs.id as string);
    }
  });
  return ids;
};

/**
 * The note body: a Tiptap rich-text editor.
 *
 * Beyond normal prose (paragraphs, headings, lists from StarterKit) it supports
 * a custom `highlightQuote` block that embeds a clipped web highlight inline and
 * links back to it. The parent inserts clips via the imperative
 * `insertHighlight` ref method, and gets notified of clicks through
 * `onActivateHighlight` so it can scroll the webview.
 */
export const NoteEditor = forwardRef(function NoteEditor(
  { onActivateHighlight, onHighlightIdsChange, onUpdate }: NoteEditorProps,
  ref: Ref<NoteEditorHandle>,
) {
  // A callback ref stored in state so the menu re-renders once the container
  // element exists and can be used as the floating-ui boundary.
  const [boundary, setBoundary] = useState<HTMLElement | null>(null);

  // Keep the change callback and the last-reported id set in refs so the
  // editor's `onUpdate` (created once) always sees current values without
  // re-instantiating the editor.
  const onIdsChangeRef = useRef(onHighlightIdsChange);
  onIdsChangeRef.current = onHighlightIdsChange;
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;
  const lastIdsRef = useRef<string>('');

  const reportIds = useCallback((editor: Editor) => {
    const ids = collectHighlightIds(editor);
    const key = ids.join(',');
    if (key === lastIdsRef.current) return; // no change to the highlight set
    lastIdsRef.current = key;
    onIdsChangeRef.current?.(ids);
  }, []);

  const editor = useEditor({
    extensions: [StarterKit, HighlightQuote],
    content: '',
    editorProps: {
      attributes: {
        // Fill the pane and read like a document. `prose` isn't available
        // (no typography plugin), so we style with plain utilities.
        class:
          'h-full outline-none text-base leading-relaxed [&_p]:my-2 [&_h1]:text-2xl [&_h1]:font-semibold [&_h2]:text-xl [&_h2]:font-semibold [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-4 [&_blockquote]:text-muted-foreground [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-sm',
      },
    },
    // Fires on every document change — including deleting a highlight block
    // with backspace — so the parent can prune removed highlights and schedule
    // a debounced autosave. Programmatic hydration (`setContent(c, false)`)
    // suppresses this event so a load isn't mistaken for a user edit.
    onUpdate: ({ editor }) => {
      reportIds(editor);
      onUpdateRef.current?.();
    },
  });

  // Keep the click handler current on editor storage so the node view can reach
  // it without stale closures.
  useEffect(() => {
    if (!editor) return;
    editor.storage.highlightQuote.onActivate = onActivateHighlight;
  }, [editor, onActivateHighlight]);

  useImperativeHandle(
    ref,
    () => ({
      insertHighlight: (attrs) => {
        if (!editor) return;
        // The clip happens while focus is in the webview, so the editor's
        // stored selection is stale (often position 0 on a fresh doc). Insert
        // at the current document end and place the caret after it, rather than
        // relying on a selection that isn't where the user is looking.
        const end = editor.state.doc.content.size;
        editor
          .chain()
          .focus()
          .insertContentAt(end, { type: 'highlightQuote', attrs })
          .run();
      },
      removeHighlight: (id) => {
        if (!editor) return;
        // Find the block with this id and delete just that node.
        let target: { from: number; to: number } | null = null;
        editor.state.doc.descendants((node, pos) => {
          if (
            !target &&
            node.type.name === 'highlightQuote' &&
            node.attrs.id === id
          ) {
            target = { from: pos, to: pos + node.nodeSize };
            return false; // stop descending
          }
          return undefined;
        });
        if (target) {
          editor
            .chain()
            .focus()
            .deleteRange(target as { from: number; to: number })
            .run();
        }
      },
      focus: () => {
        editor?.chain().focus().run();
      },
      setContent: (content, emitUpdate = false) => {
        if (!editor) return;
        // `setContent` replaces the whole document. We keep the reported-ids
        // cache in sync so the next real edit still fires `onHighlightIdsChange`
        // correctly, and default `emitUpdate` to false so hydration doesn't look
        // like a user edit (which would trip autosave on load).
        editor.commands.setContent(content, { emitUpdate });
        lastIdsRef.current = collectHighlightIds(editor).join(',');
      },
      getJSON: () => editor?.getJSON() ?? null,
    }),
    [editor],
  );

  // Clicking the empty area below the text should place the caret at the end,
  // like any text editor. We use `onClick` (not `onMouseDown`) so it never
  // fires during a drag-selection — that would collapse the selection and stop
  // the bubble menu from appearing. We also only act when the click landed on
  // the container/wrapper itself, not on the editable content (ProseMirror
  // handles caret placement there).
  const focusAtEndOnBlankClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!editor) return;
    const target = e.target as HTMLElement;
    if (target.closest('.ProseMirror')) return; // real content click
    // The bubble menu renders inside this container; clicking a toolbar button
    // must not collapse the selection to the end (which would dismiss it).
    if (target.closest('[data-formatting-menu]')) return;
    editor.chain().focus('end').run();
  };

  return (
    <div
      ref={setBoundary}
      onClick={focusAtEndOnBlankClick}
      // `min-h-0` lets this flex child actually shrink so `overflow-y-auto`
      // only scrolls when the note is taller than the pane — an empty note
      // shows no scrollbar.
      className="min-h-0 flex-1 cursor-text overflow-y-auto"
    >
      {editor && <FormattingMenu editor={editor} boundary={boundary} />}
      <EditorContent editor={editor} className="[&_.ProseMirror]:min-h-full" />
    </div>
  );
});
