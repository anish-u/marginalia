/**
 * Pure (de)serialization of a {@link ResourceNote} to and from its on-disk
 * `Note_File` representation: a YAML frontmatter block followed by the note
 * prose as Markdown.
 *
 * This module is deliberately **Tiptap-free and I/O-free**. It owns only the
 * frontmatter schema and the file *envelope* (the `---` fenced metadata block +
 * the body). The note prose is treated as an **opaque Markdown string** that is
 * embedded verbatim in the body — the schema-aware Tiptap ↔ Markdown conversion
 * lives in the renderer (`src/ui/lib/note-markdown.ts`), where the editor schema
 * is defined. Keeping this module pure means the round-trip law (Req 7.4,
 * Property 1) can be property-tested directly, without Electron or a DOM.
 *
 * On-disk format (see design → "On-disk Note_File format"):
 *
 * ```markdown
 * ---
 * id: note-2024-earthquake
 * title: Charleston earthquake notes
 * resource:
 *   type: website-link
 *   url: https://en.wikipedia.org/wiki/1886_Charleston_earthquake
 * created: 1717000000000
 * modified: 1717000500000
 * highlights:
 *   - id: h-1a2b
 *     text: "…"
 *     prefix: "…"
 *     suffix: "…"
 *     url: https://…
 *     createdAt: 1717000100000
 * ---
 *
 * <opaque Markdown prose>
 * ```
 *
 * Note the YAML uses `created`/`modified` keys that map to the
 * `createdAt`/`modifiedAt` fields of {@link ResourceNote} — the on-disk names
 * read more naturally in a plain text editor (Req 7.1), while the in-memory
 * names match the rest of the codebase's `*At` convention.
 */

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import type { Highlight } from '@shared/highlight';
import type {
  Resource,
  ResourceNote,
  ResourceType,
  Result,
  VaultError,
} from '@shared/resource-note';

/** The frontmatter fence delimiter. */
const FENCE = '---';

/**
 * Recognized resource `type` discriminators (Req 4.2). Kept as a runtime array
 * (rather than only the compile-time {@link ResourceType} union) so
 * {@link parseNote} can validate an arbitrary on-disk value at runtime.
 */
const RECOGNIZED_RESOURCE_TYPES: readonly ResourceType[] = [
  'website-link',
  'pdf',
  'video',
];

/**
 * Shape of the metadata as it lives *in the frontmatter*. This mirrors
 * {@link ResourceNote} minus `content` (prose lives in the body) and with the
 * on-disk timestamp key names (`created`/`modified`).
 */
interface Frontmatter {
  id: string;
  title: string;
  resource: Resource;
  created: number;
  modified: number;
  highlights: Highlight[];
}

/**
 * Serialize a {@link ResourceNote} to its on-disk file string (UTF-8 Markdown
 * with a YAML frontmatter block).
 *
 * The frontmatter fields are written in a stable, human-legible order and the
 * `highlights` array preserves order and every {@link Highlight} field
 * (`id`, `text`, `prefix`, `suffix`, `url`, `createdAt`) so anchors round-trip
 * losslessly (Req 4.6, 7.4). The prose is appended verbatim as the body; this
 * function never inspects or rewrites it.
 */
export function serializeNote(note: ResourceNote): string {
  const frontmatter: Frontmatter = {
    id: note.id,
    title: note.title,
    resource: note.resource,
    created: note.createdAt,
    modified: note.modifiedAt,
    // Re-map each highlight explicitly so the on-disk field order is stable and
    // no stray properties leak into the file.
    highlights: note.content.highlights.map((h) => ({
      id: h.id,
      text: h.text,
      prefix: h.prefix,
      suffix: h.suffix,
      url: h.url,
      createdAt: h.createdAt,
    })),
  };

  // `stringify` emits a trailing newline; the fenced block is `---\n<yaml>---`.
  const yaml = stringifyYaml(frontmatter);
  const body = note.content.prose;

  // One blank line separates the frontmatter fence from the prose so the body
  // reads as its own section. The body is embedded exactly as given.
  return `${FENCE}\n${yaml}${FENCE}\n\n${body}`;
}

/**
 * Parse an on-disk file string back into a {@link ResourceNote}.
 *
 * The caller supplies the `id` (the filename stem) which is authoritative — the
 * frontmatter `id`, if present, is not trusted to override the physical
 * filename, so a renamed file still resolves to its actual identity.
 *
 * Returns a {@link Result}:
 * - `unknown-resource-type` (naming the offending value) when `resource.type`
 *   is not a recognized identifier — the file is left unchanged (Req 4.5).
 * - `note-unreadable` when the frontmatter block is missing or malformed, or a
 *   required field is absent or the wrong type (Req 6.7). The offending file is
 *   never mutated by this pure function.
 */
export function parseNote(raw: string, id: string): Result<ResourceNote> {
  const split = splitFrontmatter(raw);
  if (!split) {
    return unreadable(id, 'missing or malformed frontmatter block');
  }

  let data: unknown;
  try {
    data = parseYaml(split.frontmatter);
  } catch (err) {
    return unreadable(
      id,
      `frontmatter is not valid YAML: ${errorMessage(err)}`,
    );
  }

  if (!isRecord(data)) {
    return unreadable(id, 'frontmatter is not a mapping');
  }

  // --- title -------------------------------------------------------------
  const { title } = data;
  if (typeof title !== 'string') {
    return unreadable(id, "frontmatter 'title' must be a string");
  }

  // --- timestamps --------------------------------------------------------
  const createdAt = data.created;
  const modifiedAt = data.modified;
  if (!isFiniteNumber(createdAt)) {
    return unreadable(id, "frontmatter 'created' must be a number (epoch ms)");
  }
  if (!isFiniteNumber(modifiedAt)) {
    return unreadable(id, "frontmatter 'modified' must be a number (epoch ms)");
  }

  // --- resource ----------------------------------------------------------
  const rawResource = data.resource;
  if (!isRecord(rawResource)) {
    return unreadable(id, "frontmatter 'resource' must be a mapping");
  }
  const resourceType = rawResource.type;
  if (typeof resourceType !== 'string') {
    return unreadable(id, "frontmatter 'resource.type' must be a string");
  }
  // Req 4.5: an unrecognized discriminator is its *own* error (naming the
  // value), distinct from a generally-malformed file, and never mutates.
  if (!isRecognizedResourceType(resourceType)) {
    return {
      ok: false,
      error: {
        code: 'unknown-resource-type',
        message: `Unrecognized resource type '${resourceType}'`,
        noteId: id,
      },
    };
  }
  const resource = parseResource(resourceType, rawResource);
  if (!resource) {
    return unreadable(
      id,
      `frontmatter 'resource' is invalid for type '${resourceType}'`,
    );
  }

  // --- highlights --------------------------------------------------------
  const highlights = parseHighlights(data.highlights);
  if (!highlights) {
    return unreadable(id, "frontmatter 'highlights' is malformed");
  }

  const note: ResourceNote = {
    // The physical filename stem wins over any stored id.
    id,
    title,
    resource,
    content: {
      prose: split.body,
      highlights,
    },
    createdAt,
    modifiedAt,
  };

  return { ok: true, value: note };
}

/**
 * Split a raw file string into its frontmatter YAML and prose body.
 *
 * Recognizes a leading fenced block: the file must begin with a `---` line and
 * the frontmatter runs up to the next line that is exactly `---`. Everything
 * after that closing fence (minus a single separating newline) is the body.
 * Returns `null` when no well-formed fenced block is present.
 */
function splitFrontmatter(
  raw: string,
): { frontmatter: string; body: string } | null {
  // Normalize CRLF so parsing is line-ending agnostic; the body is taken from
  // the normalized text so a Windows-authored file round-trips predictably.
  const text = raw.replace(/\r\n/g, '\n');

  if (!text.startsWith(`${FENCE}\n`) && text !== FENCE) {
    return null;
  }

  const lines = text.split('\n');
  // lines[0] is the opening fence. Find the closing fence.
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === FENCE) {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) {
    return null;
  }

  const frontmatter = lines.slice(1, closeIdx).join('\n');

  // Body is everything after the closing fence. serializeNote writes exactly
  // one blank line between the fence and the prose, so drop a single leading
  // blank line if present to recover the original prose.
  const rest = lines.slice(closeIdx + 1);
  if (rest.length > 0 && rest[0] === '') {
    rest.shift();
  }
  const body = rest.join('\n');

  return { frontmatter, body };
}

/** Validate + narrow the resource mapping for a recognized type. */
function parseResource(
  type: ResourceType,
  raw: Record<string, unknown>,
): Resource | null {
  switch (type) {
    case 'website-link': {
      const { url } = raw;
      if (typeof url !== 'string') return null;
      return { type: 'website-link', url };
    }
    // pdf/video are reserved (Req 4.4): recognized, but carry no variant data
    // in the current implementation, so a bare `{ type }` is accepted.
    case 'pdf':
      return { type: 'pdf' };
    case 'video':
      return { type: 'video' };
  }
}

/**
 * Validate the highlights array, preserving order. Accepts a missing/empty
 * array (a note need not have highlights). Returns `null` on any structural
 * problem so the caller can surface `note-unreadable`.
 */
function parseHighlights(value: unknown): Highlight[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;

  const result: Highlight[] = [];
  for (const item of value) {
    if (!isRecord(item)) return null;
    const { id, text, prefix, suffix, url, createdAt } = item;
    if (
      typeof id !== 'string' ||
      typeof text !== 'string' ||
      typeof prefix !== 'string' ||
      typeof suffix !== 'string' ||
      typeof url !== 'string' ||
      !isFiniteNumber(createdAt)
    ) {
      return null;
    }
    result.push({ id, text, prefix, suffix, url, createdAt });
  }
  return result;
}

/** Build a `note-unreadable` error result (Req 6.7). */
function unreadable(id: string, detail: string): Result<never> {
  const error: VaultError = {
    code: 'note-unreadable',
    message: `Note '${id}' could not be parsed: ${detail}`,
    noteId: id,
  };
  return { ok: false, error };
}

function isRecognizedResourceType(value: string): value is ResourceType {
  return (RECOGNIZED_RESOURCE_TYPES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
