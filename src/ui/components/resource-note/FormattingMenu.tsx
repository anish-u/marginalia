import type { FC, ReactNode } from 'react';

import { useEditorState, type Editor } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
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

/** A single formatting button in the selection bubble menu. */
const MenuButton: FC<{
  onClick: () => void;
  active?: boolean;
  label: string;
  children: ReactNode;
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
export const FormattingMenu: FC<{
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
