/**
 * Renderer-side conversion between the Tiptap note document and the Markdown
 * prose that lives in a Note_File body.
 *
 * WHY THIS LIVES IN THE RENDERER (not in `note-file.ts`):
 * the editor schema — `StarterKit` plus the custom `highlightQuote` node — is
 * defined here in the renderer. The main-process `note-file.ts` deliberately
 * stays Tiptap-free and treats `NoteContent.prose` as an opaque Markdown string
 * it embeds in the file body (see design: *Tiptap document ↔ on-disk Markdown
 * mapping*). This module owns the schema-aware half of that contract: turning a
 * Tiptap document into readable Markdown on save, and back into a Tiptap
 * document on load.
 *
 * WHY prosemirror-markdown (not tiptap-markdown / @tiptap/markdown):
 * the round trip has to be *deterministic and reversible* for the custom
 * `highlightQuote` directive (design Correctness Property 1). `prosemirror-markdown`
 * is the ProseMirror team's own serializer/parser and gives us direct,
 * per-node control over both directions — exactly what the `> [!highlight id=…]`
 * directive mapping needs. It is fully compatible with `@tiptap/pm`, which
 * re-exports the same `prosemirror-model`. We configure it against the *actual*
 * editor schema (derived from the same extension list `NoteEditor` uses) so the
 * conversion can never drift from what the editor renders.
 *
 * THE highlightQuote MAPPING (design):
 * the atomic `highlightQuote` node ({ id, text, url }) maps to a GitHub-style
 * highlighted blockquote directive so it stays human-readable *and* reversible:
 *
 *   > [!highlight id=<id>]
 *   >
 *   > <the highlight text, verbatim>
 *
 * Only the `id` and visible `text` live in the prose; the `url` (and the full
 * anchor context: prefix/suffix/createdAt) is the frontmatter `highlights`
 * array's job — that array is the single source of truth for anchoring. On
 * parse we resolve `url` back by looking the `id` up in that array. A blockquote
 * *without* the marker parses as an ordinary blockquote (StarterKit).
 */

import { getSchema, type Editor, type JSONContent } from '@tiptap/core';
import { StarterKit } from '@tiptap/starter-kit';
import {
  MarkdownParser,
  MarkdownSerializer,
  MarkdownSerializerState,
  type ParseSpec,
} from 'prosemirror-markdown';
import type { Node as ProseMirrorNode, Schema } from '@tiptap/pm/model';
import MarkdownIt from 'markdown-it';

import { HighlightQuote } from '@ui/components/resource-note/highlight-quote-node';
import type { Highlight } from '@shared/highlight';

/**
 * A Tiptap/ProseMirror document as plain JSON — the shape the editor accepts as
 * `content` and emits from `editor.getJSON()`. Aliased so callers of this
 * module don't need to reach into `@tiptap/core` for the type.
 */
export type TiptapContent = JSONContent;

/**
 * The exact extension list the note editor uses. Kept in one place so the
 * serializer/parser schema stays identical to what `NoteEditor` instantiates.
 * If `NoteEditor` gains an extension, add it here too.
 */
const NOTE_EXTENSIONS = [StarterKit, HighlightQuote];

/**
 * The ProseMirror schema for the note editor, derived from the same extensions
 * the live editor uses. Built once — schemas are immutable and reusable.
 */
const noteSchema: Schema = getSchema(NOTE_EXTENSIONS);

/** Marker that identifies a `highlightQuote` blockquote in the Markdown body. */
const HIGHLIGHT_MARKER = /^\[!highlight id=(\S+)\]$/;

// ---------------------------------------------------------------------------
// Serializer (Tiptap document → Markdown)
// ---------------------------------------------------------------------------

/**
 * Node serializers keyed by the *Tiptap* node names (camelCase: `bulletList`,
 * `codeBlock`, `hardBreak`, …), which differ from prosemirror-markdown's
 * defaults (`bullet_list`, `code_block`, …). Each handler mirrors the standard
 * prosemirror-markdown behavior for that node, adapted to our schema, plus the
 * custom `highlightQuote` directive.
 */
const nodeSerializers: {
  [name: string]: (
    state: MarkdownSerializerState,
    node: ProseMirrorNode,
    parent: ProseMirrorNode,
    index: number,
  ) => void;
} = {
  blockquote(state, node) {
    state.wrapBlock('> ', null, node, () => state.renderContent(node));
  },

  paragraph(state, node) {
    state.renderInline(node);
    state.closeBlock(node);
  },

  heading(state, node) {
    state.write(state.repeat('#', node.attrs.level as number) + ' ');
    state.renderInline(node, false);
    state.closeBlock(node);
  },

  codeBlock(state, node) {
    // Fence must be longer than any backtick run inside the code.
    const backticks = node.textContent.match(/`{3,}/gm);
    const fence = backticks ? backticks.sort().slice(-1)[0] + '`' : '```';
    const language = (node.attrs.language as string) || '';
    state.write(fence + language + '\n');
    state.text(node.textContent, false);
    state.write('\n');
    state.write(fence);
    state.closeBlock(node);
  },

  horizontalRule(state, node) {
    state.write((node.attrs.markup as string) || '---');
    state.closeBlock(node);
  },

  bulletList(state, node) {
    state.renderList(node, '  ', () => ((node.attrs.bullet as string) || '*') + ' ');
  },

  orderedList(state, node) {
    const start = (node.attrs.start as number) ?? 1;
    const maxW = String(start + node.childCount - 1).length;
    const space = state.repeat(' ', maxW + 2);
    state.renderList(node, space, (i) => {
      const nStr = String(start + i);
      return state.repeat(' ', maxW - nStr.length) + nStr + '. ';
    });
  },

  listItem(state, node) {
    state.renderContent(node);
  },

  hardBreak(state, node, parent, index) {
    for (let i = index + 1; i < parent.childCount; i++) {
      if (parent.child(i).type != node.type) {
        state.write('\\\n');
        return;
      }
    }
  },

  text(state, node) {
    state.text(node.text ?? '', true);
  },

  /**
   * The custom highlight directive. Emitted as a blockquote:
   *
   *   > [!highlight id=<id>]
   *   >
   *   > <text>
   *
   * The blank blockquote line keeps the marker and the quoted text as two
   * separate paragraphs when re-parsed, so the marker line is never merged into
   * the text on the round trip.
   */
  highlightQuote(state, node) {
    const id = (node.attrs.id as string) || '';
    const text = (node.attrs.text as string) || '';
    state.wrapBlock('> ', null, node, () => {
      state.write(`[!highlight id=${id}]`);
      state.closeBlock(node);
      // `text` is one logical string; escape it so it can't be re-interpreted
      // as Markdown when parsed back.
      state.text(text, false);
    });
    state.closeBlock(node);
  },
};

/**
 * Mark serializers, keyed by *Tiptap* mark names (`bold`/`italic` rather than
 * prosemirror-markdown's `strong`/`em`). `underline` has no CommonMark form, so
 * we drop the mark on serialize (its text is preserved).
 */
const markSerializers: MarkdownSerializer['marks'] = {
  bold: { open: '**', close: '**', mixable: true, expelEnclosingWhitespace: true },
  italic: { open: '*', close: '*', mixable: true, expelEnclosingWhitespace: true },
  strike: { open: '~~', close: '~~', mixable: true, expelEnclosingWhitespace: true },
  code: {
    open: '`',
    close: '`',
    escape: false,
  },
  link: {
    open() {
      return '[';
    },
    close(_state, mark) {
      const href = (mark.attrs.href as string) || '';
      const title = mark.attrs.title as string | null;
      return (
        '](' +
        href.replace(/[()"]/g, '\\$&') +
        (title ? ` "${title.replace(/"/g, '\\"')}"` : '') +
        ')'
      );
    },
    mixable: true,
  },
  // No CommonMark equivalent; keep the text, drop the styling on round trip.
  underline: { open: '', close: '', mixable: true, expelEnclosingWhitespace: true },
};

const serializer = new MarkdownSerializer(nodeSerializers, markSerializers);

// ---------------------------------------------------------------------------
// Parser (Markdown → Tiptap document)
// ---------------------------------------------------------------------------

/**
 * Token → node/mark mapping for the markdown-it parser, keyed by markdown-it
 * token names but producing *Tiptap* schema nodes. Marker blockquotes are not
 * handled here (markdown-it has no notion of the directive); they are parsed as
 * ordinary blockquotes and rewritten into `highlightQuote` nodes afterwards.
 */
const parseTokens: { [token: string]: ParseSpec } = {
  blockquote: { block: 'blockquote' },
  paragraph: { block: 'paragraph' },
  heading: { block: 'heading', getAttrs: (tok) => ({ level: +tok.tag.slice(1) }) },
  code_block: { block: 'codeBlock', noCloseToken: true },
  fence: {
    block: 'codeBlock',
    getAttrs: (tok) => ({ language: tok.info || '' }),
    noCloseToken: true,
  },
  hr: { node: 'horizontalRule' },
  bullet_list: { block: 'bulletList' },
  ordered_list: {
    block: 'orderedList',
    getAttrs: (tok) => ({ start: +(tok.attrGet('start') ?? 0) || 1 }),
  },
  list_item: { block: 'listItem' },
  hardbreak: { node: 'hardBreak' },
  em: { mark: 'italic' },
  strong: { mark: 'bold' },
  s: { mark: 'strike' },
  link: {
    mark: 'link',
    getAttrs: (tok) => ({
      href: tok.attrGet('href'),
      title: tok.attrGet('title') || null,
    }),
  },
  code_inline: { mark: 'code', noCloseToken: true },
};

const markdownIt = MarkdownIt('commonmark', { html: false });
const parser = new MarkdownParser(noteSchema, markdownIt, parseTokens);

/**
 * Rewrite marker blockquotes into `highlightQuote` nodes.
 *
 * markdown-it turns `> [!highlight id=x]\n>\n> text` into a `blockquote` with
 * two paragraphs: the marker, then the quoted text. We detect that shape,
 * extract the `id` and `text`, resolve the `url` from the frontmatter
 * `highlights` array, and emit an atomic `highlightQuote` node. Blockquotes
 * that don't match are returned unchanged (so ordinary quotes survive).
 */
const rewriteHighlightBlocks = (
  doc: ProseMirrorNode,
  highlightsById: Map<string, Highlight>,
): TiptapContent => {
  const json = doc.toJSON() as TiptapContent;

  const mapNode = (node: TiptapContent): TiptapContent => {
    if (node.type === 'blockquote' && Array.isArray(node.content)) {
      const first = node.content[0];
      const firstText =
        first && first.type === 'paragraph'
          ? textContentOf(first)
          : '';
      const match = HIGHLIGHT_MARKER.exec(firstText.trim());
      if (match) {
        const id = match[1];
        // Everything after the marker paragraph is the quoted text.
        const text = node.content
          .slice(1)
          .map(textContentOf)
          .join('\n')
          .trim();
        const url = highlightsById.get(id)?.url ?? '';
        return { type: 'highlightQuote', attrs: { id, text, url } };
      }
    }
    if (Array.isArray(node.content)) {
      return { ...node, content: node.content.map(mapNode) };
    }
    return node;
  };

  return mapNode(json);
};

/** Recursively gather the visible text of a JSON node. */
const textContentOf = (node: TiptapContent): string => {
  if (typeof node.text === 'string') return node.text;
  if (Array.isArray(node.content)) return node.content.map(textContentOf).join('');
  return '';
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Narrow test for a live Tiptap `Editor` (vs. a document value). */
const isEditor = (
  doc: Editor | TiptapContent | ProseMirrorNode,
): doc is Editor => typeof (doc as Editor).getJSON === 'function';

/**
 * Serialize a Tiptap document to the Markdown prose stored in a Note_File body.
 *
 * Accepts a live Tiptap `Editor`, a document as JSON (`editor.getJSON()`), or a
 * `ProseMirrorNode`. An empty document serializes to an empty string, so an
 * empty note produces an empty body.
 */
export function docToMarkdown(
  doc: Editor | TiptapContent | ProseMirrorNode,
): string {
  if (isEditor(doc)) {
    return serializer.serialize(noteSchema.nodeFromJSON(doc.getJSON()));
  }
  // A ProseMirror `Node`'s `type` is a `NodeType` object; a JSON document's
  // `type` is the node-name string. That difference tells the two apart without
  // relying on `instanceof` (which is brittle across module/realm boundaries).
  const isProseMirrorNode = typeof (doc as ProseMirrorNode).type === 'object';
  const node = isProseMirrorNode
    ? (doc as ProseMirrorNode)
    : noteSchema.nodeFromJSON(doc as TiptapContent);
  return serializer.serialize(node);
}

/**
 * Parse Markdown prose (a Note_File body) back into a Tiptap document.
 *
 * `highlights` is the frontmatter anchor array; it supplies the `url` for each
 * `highlightQuote` node, resolved by `id`. Empty/blank Markdown parses to an
 * empty Tiptap document.
 */
export function markdownToDoc(
  markdown: string,
  highlights: readonly Highlight[] = [],
): TiptapContent {
  const highlightsById = new Map(highlights.map((h) => [h.id, h]));
  // markdown-it/prosemirror-markdown returns an empty doc (with a single empty
  // paragraph) for blank input, which is the canonical empty Tiptap document.
  const doc = parser.parse(markdown ?? '');
  return rewriteHighlightBlocks(doc, highlightsById);
}
