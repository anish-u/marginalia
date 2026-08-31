import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type FC,
  type Ref,
} from 'react';

import {
  EditorContent,
  useEditor,
  useEditorState,
  type Editor,
} from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import { StarterKit } from '@tiptap/starter-kit';
import {
  Bold,
  Code,
  Heading1,
  Heading2,
  Italic,
  List,
  ListOrdered,
  Quote,
  Strikethrough,
} from 'lucide-react';

import { cn } from '@/lib/utils';

import {
  HighlightQuote,
  type HighlightActivate,
  type HighlightQuoteAttrs,
} from '@ui/lib/highlight-quote-node';

/** Imperative API the parent uses to drive the editor. */
export interface NoteEditorHandle {
  /** Insert a highlight-quote block at the current cursor position. */
  insertHighlight: (attrs: HighlightQuoteAttrs) => void;
  /** Remove the highlight-quote block with the given id from the document. */
  removeHighlight: (id: string) => void;
  /** Move focus into the editor. */
  focus: () => void;
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

/** A single formatting button in the selection bubble menu. */
const MenuButton: FC<{
  onClick: () => void;
  active?: boolean;
  label: string;
  children: React.ReactNode;
}> = ({ onClick, active, label, children }) => (
  <button
    type="button"
    // Prevent the editor from losing selection when the button is pressed.
    onMouseDown={(e) => e.preventDefault()}
    onClick={onClick}
    aria-label={label}
    title={label}
    aria-pressed={active}
    className={cn(
      'flex size-7 items-center justify-center rounded transition-colors',
      active
        ? // Clearly filled/darkened when the format is applied to the selection.
          'bg-primary text-primary-foreground hover:bg-primary/90'
        : 'text-foreground hover:bg-accent hover:text-accent-foreground',
    )}
  >
    {children}
  </button>
);

/** The floating formatting toolbar shown when a range of text is selected. */
const FormattingMenu: FC<{
  editor: Editor;
  /** Clamps the menu inside the note pane so it can't cross the splitter. */
  boundary: HTMLElement | null;
}> = ({ editor, boundary }) => {
  // Subscribe to editor state so the active flags recompute whenever the
  // selection moves or formatting changes. Reading `editor.isActive(...)`
  // directly in render is stale — the component wouldn't re-render on selection
  // changes, so e.g. an H1 wouldn't light up its button.
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      strike: e.isActive('strike'),
      code: e.isActive('code'),
      h1: e.isActive('heading', { level: 1 }),
      h2: e.isActive('heading', { level: 2 }),
      bulletList: e.isActive('bulletList'),
      orderedList: e.isActive('orderedList'),
      blockquote: e.isActive('blockquote'),
    }),
  });

  return (
    <BubbleMenu
      editor={editor}
      // Only show for an actual text selection. Without this, selecting a
      // highlight-quote block (which happens right after clipping, since the
      // node gets selected) would pop the formatting toolbar over the clip.
      shouldShow={({ state }) => {
        const { selection } = state;
        // NodeSelection has a `.node`; a text range selection does not.
        const isNodeSelection = 'node' in selection && selection.node != null;
        return !selection.empty && !isNodeSelection;
      }}
      // `fixed` positions against the viewport (the note pane clips overflow),
      // and flip/shift keep the menu fully visible. The `boundary` clamps
      // shifting to the note pane so the menu never crosses the splitter into
      // the browser pane where it couldn't be clicked.
      options={{
        strategy: 'fixed',
        placement: 'top',
        offset: 8,
        flip: boundary ? { boundary, padding: 8 } : true,
        shift: boundary ? { boundary, padding: 8 } : { padding: 8 },
      }}
      data-formatting-menu
      className="z-50 flex items-center gap-0.5 rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
    >
      <MenuButton
        label="Bold"
        active={state.bold}
        onClick={() => editor.chain().focus().toggleBold().run()}
      >
        <Bold className="size-4" />
      </MenuButton>
      <MenuButton
        label="Italic"
        active={state.italic}
        onClick={() => editor.chain().focus().toggleItalic().run()}
      >
        <Italic className="size-4" />
      </MenuButton>
      <MenuButton
        label="Strikethrough"
        active={state.strike}
        onClick={() => editor.chain().focus().toggleStrike().run()}
      >
        <Strikethrough className="size-4" />
      </MenuButton>
      <MenuButton
        label="Inline code"
        active={state.code}
        onClick={() => editor.chain().focus().toggleCode().run()}
      >
        <Code className="size-4" />
      </MenuButton>

      <span className="mx-0.5 h-5 w-px bg-border" />

      <MenuButton
        label="Heading 1"
        active={state.h1}
        onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
      >
        <Heading1 className="size-4" />
      </MenuButton>
      <MenuButton
        label="Heading 2"
        active={state.h2}
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
      >
        <Heading2 className="size-4" />
      </MenuButton>

      <span className="mx-0.5 h-5 w-px bg-border" />

      <MenuButton
        label="Bullet list"
        active={state.bulletList}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
      >
        <List className="size-4" />
      </MenuButton>
      <MenuButton
        label="Numbered list"
        active={state.orderedList}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
      >
        <ListOrdered className="size-4" />
      </MenuButton>
      <MenuButton
        label="Quote"
        active={state.blockquote}
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
      >
        <Quote className="size-4" />
      </MenuButton>
    </BubbleMenu>
  );
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
  { onActivateHighlight, onHighlightIdsChange }: NoteEditorProps,
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
    // with backspace — so the parent can prune removed highlights.
    onUpdate: ({ editor }) => reportIds(editor),
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
