// Feature: vault-and-notes, Property 1: Note serialization round-trip preserves the note

/**
 * Property-based test for the pure `note-file.ts` (de)serialization core — the
 * heart of Req 7.4 (Property 1). The law under test:
 *
 *   For any valid ResourceNote, parseNote(serializeNote(note), note.id) is `ok`
 *   and *equivalent* to the original, where equivalence (per Property 1) means:
 *     - the `title` string,
 *     - the `resource` (including `type` and `url`),
 *     - the prose *text content*, and
 *     - the ordered list of highlights, each preserving `id`, `text`, `prefix`,
 *       `suffix`, `url`, and `createdAt`,
 *   are all identical to the original.
 *
 * Property 1 defines prose equivalence at the *text content* level. In this
 * module, however, prose is an **opaque Markdown string** embedded verbatim in
 * the file body (the Tiptap↔Markdown conversion lives in the renderer, task 8).
 * So here the stronger claim should hold: the opaque prose round-trips
 * byte-for-byte through the `---`/`---` envelope — EXCEPT for a small set of
 * envelope-imposed normalizations that are inherent to embedding arbitrary text
 * in a fenced Markdown body. We characterize those precisely below and
 * constrain the prose generator to the space of strings the on-disk envelope
 * can faithfully represent, so the property tests the real correctness law
 * rather than a weakened one. The excluded cases are documented in
 * `PROSE_ENVELOPE_NOTES` for the task-3 checkpoint review.
 *
 * Validates: Requirements 7.4, 4.6, 5.2, 6.3, 7.3
 */

import { describe, expect, it } from 'vitest';
// Namespace import: fast-check re-exports its helpers as named exports *and* as
// a default namespace, so `import fc from 'fast-check'` + `fc.string()` trips
// eslint-plugin-import's no-named-as-default-member rule. A `* as` import is the
// clean, warning-free way to keep the conventional `fc.` call sites.
import * as fc from 'fast-check';

import type { Highlight } from '@shared/highlight';
import type { ResourceNote, WebsiteLinkResource } from '@shared/resource-note';

import { parseNote, serializeNote } from '@main/vault/note-file';

/**
 * Documented prose edge cases that do NOT round-trip byte-for-byte through the
 * on-disk envelope, and why. These are inherent properties of embedding an
 * arbitrary string as the body of a `---\n<yaml>---\n\n<body>` file, not defects
 * in the round-trip law itself (Property 1 only requires *text content*
 * equivalence for prose, and the renderer produces well-formed Markdown, never
 * these raw shapes). The generator below excludes them so the byte-for-byte
 * assertion is meaningful.
 *
 * 1. CRLF line endings. `parseNote` normalizes `\r\n` → `\n` (via
 *    `splitFrontmatter`) so a file authored on Windows parses predictably.
 *    Prose containing `\r` therefore does not survive byte-for-byte; the text
 *    content (lines) is preserved. → generator excludes `\r`.
 *
 * 2. Leading blank line. `serializeNote` writes exactly one blank line between
 *    the closing fence and the prose (`---\n\n<body>`). On parse,
 *    `splitFrontmatter` drops a *single* leading blank line after the fence to
 *    recover the body. If the prose itself begins with a newline (i.e. its
 *    first line is blank), that leading blank is indistinguishable from the
 *    separator and is absorbed. → generator excludes prose beginning with `\n`.
 *
 * 3. A line consisting of exactly `---` as the FIRST line of the prose. Because
 *    the separator blank line is dropped first, a body whose first content line
 *    is exactly `---` would be re-read as (part of) a fence on a subsequent
 *    parse of a hand-edited file. The current split keys off the *first* `---`
 *    after the opening fence for the frontmatter close, so a `---` inside the
 *    body is safe for a single round-trip — but to keep the generated corpus
 *    unambiguous and the law crisp we exclude prose whose lines are exactly
 *    `---`. (Documented as a known envelope ambiguity; the renderer never emits
 *    a bare `---` prose line as an artifact of a highlightQuote/StarterKit doc.)
 *
 * 4. Trailing whitespace/newlines are preserved byte-for-byte (no trimming), so
 *    they are NOT excluded — they are exercised by the generator.
 */
const PROSE_ENVELOPE_NOTES = {
  crlfNormalized: 'CR (\\r) is normalized away on parse',
  leadingBlankAbsorbed: 'a leading blank line is absorbed by the fence separator',
  bareDashLine: 'a prose line that is exactly "---" is an envelope ambiguity',
} as const;
void PROSE_ENVELOPE_NOTES;

/**
 * Prose the on-disk envelope can represent byte-for-byte. Unicode-inclusive
 * (fast-check `string({ unit: 'binary' })` covers the full code-point range —
 * astral planes, combining marks, RTL, emoji), but filtered to exclude the
 * envelope-imposed edge cases characterized above.
 */
const proseArb = fc
  // `unit: 'binary'` = any code point across the full Unicode range (astral
  // planes, combining marks, RTL, emoji) — the fast-check v4 successor to the
  // old `fullUnicodeString`.
  .string({ unit: 'binary', maxLength: 400 })
  .filter((s) => {
    if (s.includes('\r')) return false; // (1) CRLF normalization
    if (s.startsWith('\n')) return false; // (2) leading blank line absorbed
    // (3) any line that is exactly the fence delimiter
    if (s.split('\n').some((line) => line === '---')) return false;
    return true;
  });

/**
 * A title of 0–255 characters, including whitespace-only titles (Req 4.1, 5.7).
 * Unicode-inclusive. `note-file.ts` stores the title verbatim (default-title
 * substitution is the Note_Store's job, task 4, not the serializer's), so the
 * serializer must round-trip even an empty or whitespace-only title as-is.
 *
 * YAML edge cases: a title that is only whitespace, or that looks like a YAML
 * scalar (`~`, `null`, `123`, leading/trailing spaces) must still round-trip as
 * the original *string*. The `yaml` library quotes as needed; if any generated
 * title does not survive, that is a genuine serializer bug to report, not to
 * paper over — so titles are NOT filtered.
 */
const titleArb = fc.string({ unit: 'binary', maxLength: 255 });

/** A whitespace-only title generator, folded into `titleArb` occurrences. */
const whitespaceTitleArb = fc
  .array(fc.constantFrom(' ', '\t'), { minLength: 1, maxLength: 8 })
  .map((chars) => chars.join(''));

/** Valid http/https website-link resource (Req 4.3). */
const websiteLinkArb: fc.Arbitrary<WebsiteLinkResource> = fc.webUrl().map(
  (url) => ({ type: 'website-link', url }),
);

/**
 * A single highlight with arbitrary text/prefix/suffix (unicode-inclusive) and
 * a finite epoch-ms `createdAt`. `id` and `url` are arbitrary non-empty-ish
 * strings; every field is preserved verbatim through the frontmatter YAML.
 */
const highlightArb: fc.Arbitrary<Highlight> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 24 }),
  text: fc.string({ unit: 'binary', maxLength: 120 }),
  prefix: fc.string({ unit: 'binary', maxLength: 40 }),
  suffix: fc.string({ unit: 'binary', maxLength: 40 }),
  url: fc.webUrl(),
  createdAt: fc.integer({ min: 0, max: 4_102_444_800_000 }),
});

/** An ordered array of highlights (order is part of the equivalence, Req 7.4). */
const highlightsArb = fc.array(highlightArb, { maxLength: 6 });

/** A full valid ResourceNote (website-link only — the implemented variant). */
const resourceNoteArb: fc.Arbitrary<ResourceNote> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 32 }),
  title: fc.oneof(titleArb, whitespaceTitleArb),
  resource: websiteLinkArb,
  content: fc.record({
    prose: proseArb,
    highlights: highlightsArb,
  }),
  createdAt: fc.integer({ min: 0, max: 4_102_444_800_000 }),
  modifiedAt: fc.integer({ min: 0, max: 4_102_444_800_000 }),
});

/**
 * The Property-1 equivalence relation between the original and round-tripped
 * note: title, resource, prose *text content*, and the ordered highlight list
 * (each field). We assert prose byte-for-byte here (stronger than text-content)
 * because the generator is constrained to envelope-representable prose.
 */
function expectEquivalent(original: ResourceNote, roundTripped: ResourceNote): void {
  // Title string identical.
  expect(roundTripped.title).toBe(original.title);
  // Resource (type + url) identical.
  expect(roundTripped.resource).toEqual(original.resource);
  // Prose text content identical (byte-for-byte given the constrained corpus).
  expect(roundTripped.content.prose).toBe(original.content.prose);
  // Ordered highlight list identical, field by field.
  expect(roundTripped.content.highlights).toEqual(original.content.highlights);
  // Metadata that also travels through the frontmatter.
  expect(roundTripped.id).toBe(original.id);
  expect(roundTripped.createdAt).toBe(original.createdAt);
  expect(roundTripped.modifiedAt).toBe(original.modifiedAt);
}

describe('note-file round-trip (Property 1)', () => {
  it('parseNote(serializeNote(note), note.id) is ok and equivalent to the original', () => {
    fc.assert(
      fc.property(resourceNoteArb, (note) => {
        const serialized = serializeNote(note);
        const parsed = parseNote(serialized, note.id);

        // Must parse successfully.
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return; // narrows for TS; the assertion above already failed.

        expectEquivalent(note, parsed.value);
      }),
      { numRuns: 300 },
    );
  });

  it('honors the passed id over any frontmatter id (id is authoritative)', () => {
    fc.assert(
      fc.property(resourceNoteArb, fc.string({ minLength: 1, maxLength: 32 }), (note, otherId) => {
        // Serialize under the note's own id, then parse claiming a different
        // physical filename stem. The parsed id must be the *passed* id.
        const serialized = serializeNote(note);
        const parsed = parseNote(serialized, otherId);

        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;
        expect(parsed.value.id).toBe(otherId);
        // Everything else still round-trips.
        expect(parsed.value.title).toBe(note.title);
        expect(parsed.value.resource).toEqual(note.resource);
        expect(parsed.value.content.prose).toBe(note.content.prose);
        expect(parsed.value.content.highlights).toEqual(note.content.highlights);
      }),
      { numRuns: 100 },
    );
  });
});
