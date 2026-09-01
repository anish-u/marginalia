/**
 * Shared resource-note types — the single source of truth for the persisted
 * entity and its cross-process (preload ↔ renderer) contract.
 *
 * A resource note pairs a *resource* (an external thing the note is about) with
 * *note content* (the user's prose plus clipped highlights). These types are
 * imported on both sides of the IPC bridge so the preload script and the React
 * app can never drift out of sync.
 *
 * Reuses the existing `Highlight` type from `@shared/highlight` unchanged
 * (Req 4.6): a highlight's shape is already defined there and shared with the
 * guest annotator, so we do not redefine it.
 */

import type { Highlight } from '@shared/highlight';

/**
 * Recognized resource variant identifiers (Req 4.2).
 *
 * This union is intentionally *closed*: every variant Marginalia will ever
 * recognize is listed here, even the ones not yet implemented. Keeping it
 * closed means an exhaustive `switch` over a `Resource['type']` can rely on a
 * `never` default branch to catch — at compile time — any future variant that
 * is added without being handled everywhere it must be (Req 4.2, 4.4).
 */
export type ResourceType = 'website-link' | 'pdf' | 'video';

/**
 * The only implemented variant (Req 4.3).
 *
 * A website-link resource is identified by the web URL of the linked page,
 * which must be a non-empty http/https string (validated on write).
 */
export interface WebsiteLinkResource {
  type: 'website-link';
  /** http/https URL of the linked page; non-empty (validated on write). */
  url: string;
}

/**
 * Reserved future variants (Req 4.4). Declared so the {@link Resource} union is
 * closed and exhaustive `switch` statements are future-proof, but NOT created
 * or rendered by the current implementation. No variant-specific creation,
 * reading, or rendering behavior exists for these yet.
 */
export interface PdfResource {
  type: 'pdf'; /* reserved */
}
export interface VideoResource {
  type: 'video'; /* reserved */
}

/**
 * Discriminated union keyed on `type` (Req 4.2).
 *
 * Closed by design: adding a new resource kind means adding it here (and to
 * {@link ResourceType}), which surfaces every place that must handle it via
 * exhaustiveness checking rather than silently ignoring the new variant.
 */
export type Resource = WebsiteLinkResource | PdfResource | VideoResource;

/**
 * The user-authored body: rich-text prose plus embedded highlights.
 * `prose` is the editor document serialized to Markdown (readable text, Req 7.3);
 * `highlights` is the ordered anchor list, kept alongside so anchors survive
 * even when the prose Markdown is hand-edited.
 */
export interface NoteContent {
  /** Tiptap document serialized to Markdown. */
  prose: string;
  /** Ordered clips; each is the existing @shared/highlight Highlight. */
  highlights: Highlight[];
}

/** A persisted resource note (Req 4.1). */
export interface ResourceNote {
  /** Stable, unique, immutable id (also the filename stem). */
  id: string;
  /** 0–255 chars; default applied on write if blank (Req 5.7). */
  title: string;
  resource: Resource;
  content: NoteContent;
  /** Epoch ms, set once on first write (Req 4.1, 5.4). */
  createdAt: number;
  /** Epoch ms, updated on every write/modification (Req 4.7, 5.4). */
  modifiedAt: number;
}

/** Lightweight row for the notes list (avoids loading full prose, Req 3). */
export interface ResourceNoteSummary {
  id: string;
  title: string;
  resourceType: ResourceType;
  modifiedAt: number;
}

/**
 * Discriminated result type so IPC returns errors as data, not exceptions.
 *
 * Several requirements demand that an error be *returned* while state is left
 * unchanged (Req 1.7, 2.3, 2.4, 4.5, 5.5, 6.4). Modeling errors as data across
 * the IPC boundary makes those "leave-unchanged, return-error" contracts
 * explicit and testable, and avoids leaking raw Node error objects to the
 * renderer.
 *
 * The success branch carries an optional, additive `diagnostics` array for
 * *non-fatal* problems that don't invalidate the result (Req 6.7). The listing
 * flow uses it: a partly-corrupt vault still succeeds — the parseable notes are
 * returned in `value` while the files that were skipped are reported in
 * `diagnostics`. It is `undefined`/absent on ordinary successes, so every
 * existing `{ ok: true, value }` construction remains valid unchanged.
 */
export type Result<T> =
  | { ok: true; value: T; diagnostics?: VaultError[] }
  | { ok: false; error: VaultError };

export interface VaultError {
  code:
    | 'no-vault'            // Req 5.6
    | 'not-a-vault'         // Req 2.3
    | 'vault-unreadable'    // Req 2.4
    | 'write-failed'        // Req 5.5
    | 'note-not-found'      // Req 6.4
    | 'note-unreadable'     // Req 6.7
    | 'unknown-resource-type' // Req 4.5
    | 'marker-create-failed'  // Req 1.7
    | 'delete-failed';        // deleting a note failed at the filesystem level
  message: string;
  /** Present where the error concerns a specific note/file. */
  noteId?: string;
  file?: string;
}

/**
 * A currently-active vault, surfaced to the renderer for boot + display
 * (Req 2.6). The `path` is the absolute filesystem path of the vault folder;
 * `name` is its basename, shown as the vault name.
 *
 * Lives here (rather than in `@shared/ipc`) so the resource-note module owns
 * the full vault/note vocabulary and `MarginaliaApi` can import it.
 */
export interface VaultInfo {
  /** Absolute filesystem path (for display, Req 2.6). */
  path: string;
  /** Folder basename, shown as the vault name. */
  name: string;
}

/**
 * Input shape for writes: the caller supplies content; the store sets
 * timestamps. `createdAt`/`modifiedAt` are deliberately omitted so the renderer
 * cannot forge them — the Note_Store is the sole authority for write times
 * (Req 5.4).
 */
export type ResourceNoteInput = Pick<
  ResourceNote,
  'id' | 'title' | 'resource' | 'content'
>;
