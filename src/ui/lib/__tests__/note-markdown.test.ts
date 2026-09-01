// @vitest-environment jsdom

/**
 * Example-based unit tests for the renderer-side Tiptap ↔ Markdown conversion
 * (`note-markdown.ts`), focused on the custom `highlightQuote` directive
 * mapping (design: *Tiptap document ↔ on-disk Markdown mapping*).
 *
 * WHY jsdom: `docToMarkdown`/`markdownToDoc` build a ProseMirror schema from the
 * editor extensions (StarterKit + the custom `highlightQuote` node). The
 * `highlightQuote` node ships a React node view, and Tiptap's `getSchema`
 * touches DOM-adjacent APIs, so these run under jsdom rather than the default
 * `node` environment.
 *
 * These are worked examples (not the property tests, which live over the pure
 * `note-file.ts` core). They pin the three behaviors task 8.1 promises:
 *   1. a doc with one or more `highlightQuote` blocks round-trips through
 *      serialize → parse, preserving each block's `id`, visible `text`, the
 *      `url` *resolved from the frontmatter highlights array*, and their order;
 *   2. an ordinary blockquote (no `[!highlight …]` marker) survives as a plain
 *      blockquote — the directive rewrite must not capture it;
 *   3. the empty document serializes to an empty body and parses back to an
 *      empty document.
 *
 * Validates: Requirements 7.3, 4.6
 */

import { describe, expect, it } from 'vitest';

import type { Highlight } from '@shared/highlight';

import {
  docToMarkdown,
  markdownToDoc,
  type TiptapContent,
} from '@ui/lib/note-markdown';

/**
 * Build a `Highlight` with the fields the mapping actually consults (`id`,
 * `url`) plus filler for the rest, so tests read as intent, not boilerplate.
 */
function makeHighlight(id: string, url: string): Highlight {
  return {
    id,
    url,
    text: `text-for-${id}`,
    prefix: '',
    suffix: '',
    createdAt: 0,
  };
}

/** A `highlightQuote` node as it appears in a Tiptap JSON document. */
function highlightQuoteNode(
  id: string,
  text: string,
  url = '',
): TiptapContent {
  return { type: 'highlightQuote', attrs: { id, text, url } };
}

/** A plain paragraph node with a single text child. */
function paragraph(text: string): TiptapContent {
  return { type: 'paragraph', content: [{ type: 'text', text }] };
}

/** A `doc` wrapper around top-level block nodes. */
function doc(...content: TiptapContent[]): TiptapContent {
  return { type: 'doc', content };
}

/**
 * Depth-first collect every node of a given type from a Tiptap JSON document,
 * preserving document order — used to assert both presence and ordering of
 * `highlightQuote` blocks after a round trip.
 */
function collect(node: TiptapContent, type: string): TiptapContent[] {
  const found: TiptapContent[] = [];
  const walk = (n: TiptapContent) => {
    if (n.type === type) found.push(n);
    if (Array.isArray(n.content)) n.content.forEach(walk);
  };
  walk(node);
  return found;
}

describe('note-markdown: highlightQuote directive mapping', () => {
  it('round-trips a single highlightQuote block, resolving url from the highlights array', () => {
    const highlights: Highlight[] = [
      makeHighlight('h1', 'https://example.com/article'),
    ];
    const input = doc(
      paragraph('Before the clip.'),
      highlightQuoteNode('h1', 'the quoted sentence', 'https://example.com/article'),
      paragraph('After the clip.'),
    );

    const markdown = docToMarkdown(input);
    // Serializes to the GitHub-style highlight directive blockquote.
    expect(markdown).toContain('> [!highlight id=h1]');
    expect(markdown).toContain('the quoted sentence');

    const parsed = markdownToDoc(markdown, highlights);
    const blocks = collect(parsed, 'highlightQuote');

    expect(blocks).toHaveLength(1);
    expect(blocks[0].attrs).toMatchObject({
      id: 'h1',
      text: 'the quoted sentence',
      // url is NOT carried in the prose — it is resolved from the frontmatter
      // highlights array by id on parse.
      url: 'https://example.com/article',
    });
  });

  it('preserves the order of multiple highlightQuote blocks and resolves each url by id', () => {
    const highlights: Highlight[] = [
      makeHighlight('a', 'https://site.test/a'),
      makeHighlight('b', 'https://site.test/b'),
      makeHighlight('c', 'https://site.test/c'),
    ];
    const input = doc(
      highlightQuoteNode('a', 'first clip', 'https://site.test/a'),
      paragraph('interleaved prose'),
      highlightQuoteNode('b', 'second clip', 'https://site.test/b'),
      highlightQuoteNode('c', 'third clip', 'https://site.test/c'),
    );

    const parsed = markdownToDoc(docToMarkdown(input), highlights);
    const blocks = collect(parsed, 'highlightQuote');

    // Same count and same order as authored.
    expect(blocks.map((b) => b.attrs?.id)).toEqual(['a', 'b', 'c']);
    expect(blocks.map((b) => b.attrs?.text)).toEqual([
      'first clip',
      'second clip',
      'third clip',
    ]);
    // Each url resolved from its matching highlight entry.
    expect(blocks.map((b) => b.attrs?.url)).toEqual([
      'https://site.test/a',
      'https://site.test/b',
      'https://site.test/c',
    ]);
  });

  it('resolves url to empty string when the id is missing from the highlights array', () => {
    const input = doc(highlightQuoteNode('orphan', 'clip with no anchor', ''));

    // No matching highlight passed — url cannot be resolved.
    const parsed = markdownToDoc(docToMarkdown(input), []);
    const blocks = collect(parsed, 'highlightQuote');

    expect(blocks).toHaveLength(1);
    expect(blocks[0].attrs).toMatchObject({
      id: 'orphan',
      text: 'clip with no anchor',
      url: '',
    });
  });

  it('leaves a plain blockquote (no marker) untouched — no highlightQuote produced', () => {
    const input = doc(
      { type: 'blockquote', content: [paragraph('just an ordinary quote')] },
    );

    const markdown = docToMarkdown(input);
    // A normal blockquote, without the highlight marker.
    expect(markdown).toContain('> just an ordinary quote');
    expect(markdown).not.toContain('[!highlight');

    const parsed = markdownToDoc(markdown);
    // Stays a blockquote; the directive rewrite must not capture it.
    expect(collect(parsed, 'highlightQuote')).toHaveLength(0);
    const quotes = collect(parsed, 'blockquote');
    expect(quotes).toHaveLength(1);
    // The quoted text is preserved.
    expect(JSON.stringify(quotes[0])).toContain('just an ordinary quote');
  });

  it('serializes an empty doc to an empty body and parses it back to an empty doc', () => {
    const empty = doc();

    const markdown = docToMarkdown(empty);
    expect(markdown).toBe('');

    // Blank markdown parses back to the canonical empty Tiptap document.
    const parsed = markdownToDoc('');
    expect(parsed.type).toBe('doc');
    expect(collect(parsed, 'highlightQuote')).toHaveLength(0);
    // No visible text content in the empty doc.
    expect(collect(parsed, 'text')).toHaveLength(0);
  });
});
