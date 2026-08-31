import { Node, mergeAttributes } from '@tiptap/core';
import {
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from '@tiptap/react';

/**
 * A Tiptap block node representing a clipped web highlight embedded in the note.
 *
 * It stores the anchor `id`, the quoted `text`, and the source `url` as node
 * attributes, and renders as a styled, clickable blockquote via a React node
 * view. Clicking it invokes `onActivate` (supplied through editor storage) so
 * the host can scroll the webview back to the highlight. The node is atomic —
 * you can't type inside the quote — but you can put your cursor before/after it
 * and write normal paragraphs, which is the paragraph → quote → paragraph flow.
 */

export interface HighlightQuoteAttrs {
  id: string;
  text: string;
  url: string;
}

/** Signature for the click handler stored on the editor. */
export type HighlightActivate = (id: string) => void;

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    highlightQuote: {
      /** Insert a highlight-quote block at the current selection. */
      insertHighlightQuote: (attrs: HighlightQuoteAttrs) => ReturnType;
    };
  }

  interface Storage {
    highlightQuote: {
      /** Click handler invoked when a highlight-quote block is activated. */
      onActivate: HighlightActivate | undefined;
    };
  }
}

const HighlightQuoteComponent = (props: NodeViewProps) => {
  const { id, text, url } = props.node.attrs as HighlightQuoteAttrs;
  const activate = props.editor.storage.highlightQuote.onActivate;

  return (
    <NodeViewWrapper
      as="div"
      className="my-2"
      data-highlight-id={id}
      contentEditable={false}
    >
      <button
        type="button"
        onClick={() => activate?.(id)}
        title={url ? `Jump to highlight — ${url}` : 'Jump to highlight'}
        className="block w-full cursor-pointer rounded-sm border-l-4 border-yellow-400 bg-yellow-400/10 px-3 py-2 text-left text-sm leading-snug text-foreground/90 transition-colors hover:bg-yellow-400/20"
      >
        {text}
      </button>
    </NodeViewWrapper>
  );
};

export const HighlightQuote = Node.create({
  name: 'highlightQuote',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,

  addStorage() {
    return { onActivate: undefined as HighlightActivate | undefined };
  },

  addAttributes() {
    return {
      id: { default: '' },
      text: { default: '' },
      url: { default: '' },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-highlight-quote]' }];
  },

  renderHTML({ HTMLAttributes }) {
    // Serialized form (used for persistence/copy). The React node view handles
    // the interactive rendering inside the editor.
    return [
      'div',
      mergeAttributes(HTMLAttributes, { 'data-highlight-quote': '' }),
      HTMLAttributes.text ?? '',
    ];
  },

  addCommands() {
    return {
      insertHighlightQuote:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs }),
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(HighlightQuoteComponent);
  },
});
