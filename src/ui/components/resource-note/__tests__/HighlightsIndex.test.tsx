// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

/**
 * RTL + jsdom integration examples for restored-highlight scroll and the
 * not-found indication (task 10.4).
 *
 * `HighlightsIndex` is the integration surface where the two restored-highlight
 * behaviors converge, so we drive it directly rather than mounting the whole
 * `ResourceNoteView` (which pulls in a live Tiptap editor, an Electron
 * `<webview>`, and react-router — all heavy/brittle under jsdom). In the view,
 * `onActivate` is wired straight to the annotator bridge's `scrollTo`, so a spy
 * standing in for `scrollTo` faithfully represents "clicking a restored
 * highlight scrolls the page to it" (Req 6.5). `unresolvedIds` is computed by
 * the view as the highlights `paint()` could not re-anchor, so populating it
 * here reproduces "anchor not found on the page" (Req 6.6).
 *
 * Coverage (per the acceptance criteria):
 *   - 6.5 — a restored highlight whose anchor is found, when its index row is
 *     clicked, triggers a scroll (onActivate/scrollTo called with its id) and
 *     carries no not-found badge.
 *   - 6.6 — a restored highlight whose anchor is NOT found surfaces the
 *     "Not found on page" indication yet is retained in the note: its text
 *     still renders and its jump/remove controls still work; a found highlight
 *     shows no badge.
 *
 * Validates: Requirements 6.5, 6.6
 */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HighlightsIndex } from '@/components/resource-note/HighlightsIndex';
import type { Highlight } from '@shared/highlight';

// --- Test helpers ----------------------------------------------------------

const highlight = (over: Partial<Highlight> = {}): Highlight => ({
  id: 'h-1',
  text: 'A clipped sentence',
  prefix: 'before ',
  suffix: ' after',
  url: 'https://example.com/article',
  createdAt: 1_000,
  ...over,
});

/**
 * The index is collapsed by default; expand it so the rows (and their badges /
 * controls) are in the DOM. The toggle is the button labelled "N highlight(s)".
 */
const expandIndex = () => {
  fireEvent.click(screen.getByRole('button', { name: /highlight/i }));
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// --- 6.5: restored highlight found → scroll --------------------------------

describe('HighlightsIndex — restored highlight found (Req 6.5)', () => {
  it('clicking a found highlight triggers a scroll to it (onActivate/scrollTo)', () => {
    // `scrollTo` is what ResourceNoteView passes as `onActivate`; the spy
    // stands in for the annotator bridge.
    const scrollTo = vi.fn();
    const found = highlight({ id: 'found-1', text: 'Restored, anchor located' });

    render(
      <HighlightsIndex
        highlights={[found]}
        onActivate={scrollTo}
        onRemove={() => {}}
        // Empty: this highlight's anchor was located on the page.
        unresolvedIds={new Set()}
      />,
    );

    expandIndex();

    fireEvent.click(screen.getByTitle('Jump to highlight'));

    // The scroll is triggered for exactly this highlight's id.
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith('found-1');

    // A found highlight carries no not-found indication.
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});

// --- 6.6: not found → indication, highlight retained -----------------------

describe('HighlightsIndex — highlight not found on page (Req 6.6)', () => {
  it('shows the not-found indication while retaining the highlight and its controls', () => {
    const scrollTo = vi.fn();
    const onRemove = vi.fn();
    const missing = highlight({ id: 'missing-1', text: 'Anchor gone after reload' });

    render(
      <HighlightsIndex
        highlights={[missing]}
        onActivate={scrollTo}
        onRemove={onRemove}
        // This highlight could not be re-anchored by paint().
        unresolvedIds={new Set(['missing-1'])}
      />,
    );

    expandIndex();

    // Indication is present and discoverable (role="status", exact text).
    const badge = screen.getByRole('status');
    expect(badge).toHaveTextContent('Not found on page');

    // The highlight is RETAINED, not dropped: its text still renders...
    expect(screen.getByText('Anchor gone after reload')).toBeInTheDocument();

    // ...and its controls still work (jump + remove operate on its id).
    fireEvent.click(screen.getByTitle('Jump to highlight'));
    expect(scrollTo).toHaveBeenCalledWith('missing-1');

    fireEvent.click(screen.getByRole('button', { name: 'Remove highlight' }));
    expect(onRemove).toHaveBeenCalledWith('missing-1');
  });

  it('badges only the unresolved highlight, leaving the found one unmarked', () => {
    const found = highlight({ id: 'found-1', text: 'Still on the page' });
    const missing = highlight({ id: 'missing-1', text: 'No longer findable' });

    render(
      <HighlightsIndex
        highlights={[found, missing]}
        onActivate={() => {}}
        onRemove={() => {}}
        unresolvedIds={new Set(['missing-1'])}
      />,
    );

    expandIndex();

    // Exactly one badge, and it belongs to the missing highlight's row.
    const badges = screen.getAllByRole('status');
    expect(badges).toHaveLength(1);

    const missingRow = screen.getByText('No longer findable').closest('li');
    expect(missingRow).not.toBeNull();
    expect(within(missingRow as HTMLElement).getByRole('status')).toBeInTheDocument();

    // The found highlight's row has no not-found badge.
    const foundRow = screen.getByText('Still on the page').closest('li');
    expect(foundRow).not.toBeNull();
    expect(within(foundRow as HTMLElement).queryByRole('status')).not.toBeInTheDocument();
  });
});
