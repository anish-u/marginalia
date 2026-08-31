/**
 * A text-quote anchor for a highlight captured from a webview page.
 *
 * Shared between the renderer (which stores and renders the list) and the
 * guest annotator script (which creates anchors and re-finds them in the page).
 * We use text-quote anchoring — store the exact selected text plus a little
 * surrounding context — rather than DOM/XPath offsets, because it survives
 * reloads and minor page changes. The context (`prefix`/`suffix`) disambiguates
 * when the same phrase appears more than once on the page.
 */
export interface Highlight {
  /** Stable id, assigned when the highlight is created. */
  id: string;
  /** The exact text the user selected. */
  text: string;
  /** Up to ~32 chars of text immediately before the selection. */
  prefix: string;
  /** Up to ~32 chars of text immediately after the selection. */
  suffix: string;
  /** The page URL the highlight was taken from. */
  url: string;
  /** Creation time (epoch ms). */
  createdAt: number;
}

/**
 * The payload the guest annotator returns when a selection is clipped.
 * `null` means there was no (non-empty) selection to clip.
 */
export type ClipResult = Omit<Highlight, 'id' | 'createdAt'> | null;
