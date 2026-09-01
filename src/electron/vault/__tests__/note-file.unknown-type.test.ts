// Feature: vault-and-notes, Property 5: Unrecognized resource type is a non-destructive error

/**
 * Property 5 (Req 4.5): reading a Note_File whose resource `type` is not a
 * recognized variant identifier is a *non-destructive* error. `parseNote` must:
 *   - fail with the dedicated `unknown-resource-type` code (not the catch-all
 *     `note-unreadable`),
 *   - surface the offending `type` value in the error message,
 *   - attribute the error to the caller-supplied note id, and
 *   - not mutate its input. `parseNote` is pure and I/O-free, so "SHALL NOT
 *     discard or modify the Note_File, and SHALL leave the stored Note_File
 *     unchanged" reduces here to: the raw string handed in is byte-identical
 *     afterwards and there is no disk write.
 *
 * Each generated file is otherwise entirely valid — well-formed frontmatter,
 * valid timestamps, a url, an empty highlights list — so the *only* reason to
 * fail is the unrecognized discriminator. That isolates Property 5 from the
 * generic `note-unreadable` (malformed-frontmatter) path.
 *
 * This lives in a sibling file to the Property-1 round-trip test so the two
 * pure-serialization properties are independent test suites over the same
 * module.
 *
 * Validates: Requirements 4.5
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { stringify as stringifyYaml } from 'yaml';

import { parseNote } from '@main/vault/note-file';

/**
 * The recognized resource discriminators (Req 4.2). Restated here because the
 * corresponding constant in `note-file.ts` is module-private; the generator
 * below excludes exactly these values so the `type` under test is genuinely
 * unrecognized.
 */
const RECOGNIZED_TYPES: readonly string[] = ['website-link', 'pdf', 'video'];

/**
 * Build a well-formed on-disk Note_File whose sole defect is an unrecognized
 * `resource.type`. The frontmatter is emitted with the same `yaml` library the
 * module parses with, guaranteeing the block itself is valid YAML (so a failure
 * can only come from the type check, never from malformed frontmatter).
 */
function makeNoteFileWithType(
  type: string,
  fields: {
    title: string;
    url: string;
    created: number;
    modified: number;
    body: string;
  },
): string {
  const frontmatter = stringifyYaml({
    id: 'frontmatter-id-should-be-ignored',
    title: fields.title,
    resource: { type, url: fields.url },
    created: fields.created,
    modified: fields.modified,
    highlights: [],
  });
  return `---\n${frontmatter}---\n\n${fields.body}`;
}

describe('note-file unrecognized resource type (Property 5)', () => {
  it('returns unknown-resource-type naming the offending value, input unchanged', () => {
    fc.assert(
      fc.property(
        // An arbitrary `type` that is NOT one of the recognized variants.
        fc.string().filter((t) => !RECOGNIZED_TYPES.includes(t)),
        // The caller-supplied filename-stem id (authoritative over frontmatter).
        fc.string({ minLength: 1, maxLength: 32 }),
        // Otherwise-valid frontmatter/body fields.
        fc.record({
          title: fc.string({ maxLength: 255 }),
          url: fc.webUrl(),
          created: fc.integer({ min: 0, max: 4_102_444_800_000 }),
          modified: fc.integer({ min: 0, max: 4_102_444_800_000 }),
          body: fc.string({ maxLength: 200 }),
        }),
        (type, id, fields) => {
          const raw = makeNoteFileWithType(type, fields);
          // Capture the exact input bytes to prove parse never mutates them.
          const rawBefore = String(raw);

          const result = parseNote(raw, id);

          // Fails (non-destructive error) …
          expect(result.ok).toBe(false);
          if (result.ok) return; // TS narrowing; the assertion above already failed.

          // … with the dedicated code, not the generic note-unreadable …
          expect(result.error.code).toBe('unknown-resource-type');
          // … the message names the offending value verbatim …
          expect(result.error.message).toContain(type);
          // … the error is attributed to the caller-supplied id …
          expect(result.error.noteId).toBe(id);
          // … and the input string is returned byte-for-byte unmodified.
          expect(raw).toBe(rawBefore);
        },
      ),
      { numRuns: 200 },
    );
  });
});
