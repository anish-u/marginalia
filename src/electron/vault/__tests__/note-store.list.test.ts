// Feature: vault-and-notes, Property 3: Notes are listed most-recently-modified first
// Feature: vault-and-notes, Property 4: Per-file fault isolation on load
// Feature: vault-and-notes, Property 6: Opening a missing id is a non-destructive error

/**
 * Property-based tests for `NoteStore.list` and the missing-id read, exercised
 * over *real* temp vaults under `os.tmpdir()` (design → Testing Strategy: the
 * store owns the filesystem concerns precisely so it can be property-tested
 * against a live folder without an Electron window).
 *
 * Three laws are under test:
 *
 *   Property 3 (Notes are listed most-recently-modified first, Req 6.1): given a
 *   vault of parseable notes with distinct `modified` timestamps, `list` returns
 *   exactly those notes' summaries ordered by `modifiedAt` descending.
 *   Timestamps are controlled by crafting the on-disk file bytes directly (via
 *   `serializeNote`) so the ordering assertion is deterministic and does not
 *   depend on `Date.now()` at write time.
 *
 *   Property 4 (Per-file fault isolation on load, Req 6.7 / 6.2): given a vault
 *   mixing parseable notes with corrupt `.md` files (malformed frontmatter,
 *   unknown resource type), `list` still succeeds (`ok: true`), returns exactly
 *   the parseable notes newest-first, and reports each excluded file in the
 *   additive `diagnostics` array — each diagnostic carrying the offending
 *   `file` path. Every corrupt file is left byte-for-byte unchanged on disk.
 *
 *   Property 6 (Opening a missing id is a non-destructive error, Req 6.4):
 *   reading a never-written id returns `{ ok: false, error: { code:
 *   'note-not-found', noteId } }` and leaves the vault unchanged — no file is
 *   created or removed by the failed read.
 *
 * All notes are seeded by writing crafted file bytes directly into
 * `<vault>/notes/`, using `serializeNote` for the parseable ones (so their
 * `modified` timestamps are known exactly) and raw strings for the corrupt
 * ones. This sidesteps `NoteStore.write`'s `Date.now()`-based timestamps, which
 * would otherwise make distinct-ordering hard to assert.
 *
 * Properties 3, 4, 6 — Validates: Requirements 3.1, 6.1, 6.7, 6.2, 6.4
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';
// Namespace import: fast-check re-exports helpers as named exports *and* a
// default namespace, so `import fc from 'fast-check'` + `fc.string()` trips
// eslint-plugin-import's no-named-as-default-member rule. `* as` keeps the
// conventional `fc.` call sites warning-free (matching the sibling tests).
import * as fc from 'fast-check';

import type {
  Highlight,
} from '@shared/highlight';
import type {
  ResourceNote,
  WebsiteLinkResource,
} from '@shared/resource-note';

import { serializeNote } from '@main/vault/note-file';
import { NoteStore, NOTES_DIR, NOTE_EXT } from '@main/vault/note-store';

/** Track temp vault dirs so we can clean them all up after the suite. */
const createdDirs: string[] = [];

/** Make a fresh, isolated temp vault directory for one property run. */
async function makeVaultDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'marginalia-list-'));
  createdDirs.push(dir);
  return dir;
}

afterAll(async () => {
  // Best-effort cleanup of every temp vault created during the run.
  await Promise.all(
    createdDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

/** Absolute path to a vault's notes directory. */
function notesDirOf(vaultPath: string): string {
  return path.join(vaultPath, NOTES_DIR);
}

/** Absolute on-disk path for a note id inside a vault. */
function noteFilePath(vaultPath: string, id: string): string {
  return path.join(notesDirOf(vaultPath), `${id}${NOTE_EXT}`);
}

/**
 * Write raw file bytes for a note id into `<vault>/notes/`, creating the notes
 * directory if needed. Used to seed both parseable notes (crafted via
 * `serializeNote`) and corrupt files (arbitrary strings) directly, bypassing
 * `NoteStore.write` so timestamps and byte content are fully controlled.
 */
async function seedFile(
  vaultPath: string,
  id: string,
  contents: string,
): Promise<void> {
  await fs.mkdir(notesDirOf(vaultPath), { recursive: true });
  await fs.writeFile(noteFilePath(vaultPath, id), contents, 'utf8');
}

/** Valid http/https website-link resource (the implemented variant). */
const websiteLinkArb: fc.Arbitrary<WebsiteLinkResource> = fc
  .webUrl()
  .map((url) => ({ type: 'website-link', url }));

/** A single, well-formed highlight (unicode-inclusive text/prefix/suffix). */
const highlightArb: fc.Arbitrary<Highlight> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 24 }),
  text: fc.string({ unit: 'binary', maxLength: 80 }),
  prefix: fc.string({ unit: 'binary', maxLength: 30 }),
  suffix: fc.string({ unit: 'binary', maxLength: 30 }),
  url: fc.webUrl(),
  createdAt: fc.integer({ min: 0, max: 4_102_444_800_000 }),
});

/** A filesystem-safe, flat note id stem (no separators/dots, non-empty). */
const idArb = fc
  .stringMatching(/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/)
  .filter((s) => s.length > 0);

/**
 * Prose the on-disk envelope round-trips byte-for-byte. Excludes the
 * envelope-imposed edge cases characterized in note-file.test.ts (CR
 * normalization, an absorbed leading blank line, a bare `---` line) so a
 * seeded parseable note always parses back cleanly.
 */
const proseArb = fc.string({ unit: 'binary', maxLength: 200 }).filter(
  (s) =>
    !s.includes('\r') &&
    !s.startsWith('\n') &&
    !s.split('\n').some((line) => line === '---'),
);

/**
 * A parseable {@link ResourceNote} with an explicit `modifiedAt`. `createdAt`
 * is arbitrary-but-≤ modifiedAt (created no later than last-modified); title is
 * non-blank so it round-trips as-is (the default-title substitution is a write
 * concern, covered by Property 7, and never runs here since we craft bytes).
 */
function parseableNoteArb(): fc.Arbitrary<ResourceNote> {
  return fc
    .record({
      id: idArb,
      title: fc.string({ unit: 'binary', maxLength: 80 }),
      resource: websiteLinkArb,
      prose: proseArb,
      highlights: fc.array(highlightArb, { maxLength: 4 }),
      modifiedAt: fc.integer({ min: 0, max: 4_102_444_800_000 }),
      createdOffset: fc.integer({ min: 0, max: 1_000_000_000 }),
    })
    .map((r) => ({
      id: r.id,
      title: r.title,
      resource: r.resource,
      content: { prose: r.prose, highlights: r.highlights },
      // created no later than modified.
      createdAt: Math.max(0, r.modifiedAt - r.createdOffset),
      modifiedAt: r.modifiedAt,
    }));
}

/**
 * A batch of parseable notes with **unique ids** and **distinct modifiedAt**
 * values, so the newest-first ordering is total (no ties) and each note maps to
 * its own file. We generate the raw notes, then dedupe by id and re-stamp
 * `modifiedAt` to strictly increasing distinct values by index — preserving
 * variety in every other field while guaranteeing an unambiguous expected
 * order.
 */
const distinctNotesArb: fc.Arbitrary<ResourceNote[]> = fc
  .uniqueArray(parseableNoteArb(), {
    minLength: 1,
    maxLength: 8,
    // Uniqueness is enforced *case-insensitively* (selector lowercases the id):
    // note ids are opaque filename stems seeded directly as `<id>.md`, so on a
    // case-insensitive filesystem (macOS APFS default) two ids differing only
    // in case (e.g. `Note` vs `note`) resolve to the SAME file — the vault
    // would then hold fewer files than notes generated and the newest-first /
    // id-set / count assertions flake. Lowercasing the uniqueness key keeps the
    // generated set collision-free on both case-sensitive and case-insensitive
    // filesystems (matching the sibling fix in note-store.write.test.ts).
    selector: (n) => n.id.toLowerCase(),
  })
  .map((notes) =>
    notes.map((n, i) => ({
      ...n,
      // Distinct, well-separated timestamps by position; createdAt kept ≤.
      modifiedAt: 1_000_000 + i * 1000,
      createdAt: Math.min(n.createdAt, 1_000_000 + i * 1000),
    })),
  );

/**
 * Corrupt file bodies that must be *skipped* by `list` and reported in
 * diagnostics, never parsed into a summary:
 *   - `unknown-type`: valid frontmatter shape but an unrecognized resource
 *     `type` (Req 4.5) — recognized as its own diagnostic, file untouched.
 *   - `malformed`: not a well-formed frontmatter envelope at all (Req 6.7).
 */
const corruptBodyArb: fc.Arbitrary<string> = fc.oneof(
  // Unknown resource type — otherwise-well-formed frontmatter.
  fc
    .constantFrom('spreadsheet', 'audio', 'image', 'tweet', 'unknown-kind')
    .map(
      (type) =>
        `---\ntitle: corrupt\nresource:\n  type: ${type}\ncreated: 1\nmodified: 2\nhighlights: []\n---\n\nbody`,
    ),
  // Not a frontmatter envelope: no fence, or fence never closes, or non-mapping.
  fc.constantFrom(
    'no frontmatter at all, just prose',
    '---\nthis frontmatter never closes\nstill going',
    '---\n- just\n- a\n- list\n---\n\nbody', // frontmatter is not a mapping
    '---\ntitle: 123\ncreated: not-a-number\nmodified: 2\nresource:\n  type: website-link\n  url: https://x.test\n---\n\nbody',
  ),
);

describe('NoteStore.list ordering (Property 3)', () => {
  it('returns exactly the parseable notes ordered most-recently-modified first', async () => {
    await fc.assert(
      fc.asyncProperty(distinctNotesArb, async (notes) => {
        const vault = await makeVaultDir();
        // Seed each note by crafting its exact on-disk bytes (known modifiedAt).
        for (const note of notes) {
          await seedFile(vault, note.id, serializeNote(note));
        }

        const store = new NoteStore();
        const result = await store.list(vault);

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        // No diagnostics for an all-parseable vault.
        expect(result.diagnostics).toBeUndefined();

        // Expected ids: every note, sorted by modifiedAt descending.
        const expectedIds = [...notes]
          .sort((a, b) => b.modifiedAt - a.modifiedAt)
          .map((n) => n.id);
        expect(result.value.map((s) => s.id)).toEqual(expectedIds);

        // The value contains exactly the parseable notes (same set) and each
        // summary carries the right type + timestamp.
        expect(result.value.length).toBe(notes.length);
        const byId = new Map(notes.map((n) => [n.id, n]));
        for (const summary of result.value) {
          const note = byId.get(summary.id);
          expect(note).toBeDefined();
          if (!note) return;
          expect(summary.resourceType).toBe(note.resource.type);
          expect(summary.modifiedAt).toBe(note.modifiedAt);
        }

        // modifiedAt is monotonically non-increasing down the list.
        for (let i = 1; i < result.value.length; i++) {
          expect(result.value[i - 1].modifiedAt).toBeGreaterThanOrEqual(
            result.value[i].modifiedAt,
          );
        }
      }),
      { numRuns: 100 },
    );
  });
});

describe('NoteStore.list per-file fault isolation (Property 4)', () => {
  it('skips corrupt files (reporting each in diagnostics) and returns only the parseable notes newest-first, leaving corrupt files byte-unchanged', async () => {
    await fc.assert(
      fc.asyncProperty(
        distinctNotesArb,
        // A set of corrupt files, keyed by unique ids that don't collide with
        // the parseable ones (prefixed so they can't clash). Uniqueness is
        // case-insensitive (selector lowercases the id): the ids become on-disk
        // filenames (`corrupt-<id>.md`), so `corrupt-A` / `corrupt-a` would
        // fold to the same file on a case-insensitive filesystem and make the
        // per-file diagnostics-count assertion flaky.
        fc.uniqueArray(
          fc.record({ id: idArb, body: corruptBodyArb }),
          { minLength: 1, maxLength: 6, selector: (c) => c.id.toLowerCase() },
        ),
        async (notes, corruptRaw) => {
          const vault = await makeVaultDir();

          // Seed the parseable notes.
          for (const note of notes) {
            await seedFile(vault, note.id, serializeNote(note));
          }

          // Seed the corrupt files under ids that can't collide with parseable
          // ids (prefix guarantees disjointness even if generators overlap).
          const corrupt = corruptRaw.map((c) => ({
            id: `corrupt-${c.id}`,
            body: c.body,
          }));
          for (const c of corrupt) {
            await seedFile(vault, c.id, c.body);
          }

          // Snapshot corrupt files' bytes to prove list() never mutates them.
          const corruptBefore = new Map<string, Buffer>();
          for (const c of corrupt) {
            corruptBefore.set(c.id, await fs.readFile(noteFilePath(vault, c.id)));
          }

          const store = new NoteStore();
          const result = await store.list(vault);

          // Partly-corrupt vault still succeeds (never all-or-nothing, Req 6.2).
          expect(result.ok).toBe(true);
          if (!result.ok) return;

          // Value == exactly the parseable ids, newest-first.
          const expectedIds = [...notes]
            .sort((a, b) => b.modifiedAt - a.modifiedAt)
            .map((n) => n.id);
          expect(result.value.map((s) => s.id)).toEqual(expectedIds);

          // Every corrupt file is reported in diagnostics, once, with its
          // `file` path. (There may also be extra diagnostics only for corrupt
          // files — never for a parseable note.)
          expect(result.diagnostics).toBeDefined();
          const diagnostics = result.diagnostics ?? [];
          const diagFiles = new Set(diagnostics.map((d) => d.file));
          for (const c of corrupt) {
            const expectedPath = noteFilePath(vault, c.id);
            expect(diagFiles.has(expectedPath)).toBe(true);
          }
          // One diagnostic per corrupt file — no parseable note leaked in.
          expect(diagnostics.length).toBe(corrupt.length);
          const parseablePaths = new Set(
            notes.map((n) => noteFilePath(vault, n.id)),
          );
          for (const d of diagnostics) {
            expect(d.file).toBeDefined();
            expect(parseablePaths.has(d.file ?? '')).toBe(false);
          }

          // Every corrupt file is left byte-for-byte unchanged on disk.
          for (const c of corrupt) {
            const after = await fs.readFile(noteFilePath(vault, c.id));
            const before = corruptBefore.get(c.id);
            expect(before).toBeDefined();
            if (!before) return;
            expect(after.equals(before)).toBe(true);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('an all-unparseable vault yields an empty list with diagnostics, still ok:true', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Case-insensitive id uniqueness: these ids are seeded directly as
        // `<id>.md`, so two ids differing only in case would collide on a
        // case-insensitive filesystem and undercount the diagnostics.
        fc.uniqueArray(
          fc.record({ id: idArb, body: corruptBodyArb }),
          { minLength: 1, maxLength: 6, selector: (c) => c.id.toLowerCase() },
        ),
        async (corrupt) => {
          const vault = await makeVaultDir();
          for (const c of corrupt) {
            await seedFile(vault, c.id, c.body);
          }

          const store = new NoteStore();
          const result = await store.list(vault);

          expect(result.ok).toBe(true);
          if (!result.ok) return;
          // No parseable notes -> empty value, still a success.
          expect(result.value).toEqual([]);
          // Every corrupt file surfaced as a diagnostic.
          expect((result.diagnostics ?? []).length).toBe(corrupt.length);
        },
      ),
      { numRuns: 50 },
    );
  });
});

describe('NoteStore.read missing id (Property 6)', () => {
  it('reading a never-written id returns note-not-found and leaves the vault unchanged', async () => {
    await fc.assert(
      fc.asyncProperty(
        // A vault seeded with some parseable notes …
        distinctNotesArb,
        // … and a missing id that is not among them (prefix guarantees this).
        idArb,
        async (notes, rawMissingId) => {
          const vault = await makeVaultDir();
          for (const note of notes) {
            await seedFile(vault, note.id, serializeNote(note));
          }

          // Ensure the requested id genuinely does not exist on disk.
          const missingId = `missing-${rawMissingId}`;

          // Snapshot the notes directory (names + bytes) before the read.
          const dir = notesDirOf(vault);
          const beforeNames = (await fs.readdir(dir)).slice().sort();
          const beforeBytes = new Map<string, Buffer>();
          for (const name of beforeNames) {
            beforeBytes.set(name, await fs.readFile(path.join(dir, name)));
          }

          const store = new NoteStore();
          const result = await store.read(vault, missingId);

          // Non-destructive error naming the missing id (Req 6.4).
          expect(result.ok).toBe(false);
          if (result.ok) return;
          expect(result.error.code).toBe('note-not-found');
          expect(result.error.noteId).toBe(missingId);

          // The vault is unchanged: no file created or removed, no bytes altered.
          const afterNames = (await fs.readdir(dir)).slice().sort();
          expect(afterNames).toEqual(beforeNames);
          // The missing file was NOT created.
          expect(afterNames).not.toContain(`${missingId}${NOTE_EXT}`);
          for (const name of afterNames) {
            const after = await fs.readFile(path.join(dir, name));
            const before = beforeBytes.get(name);
            expect(before).toBeDefined();
            if (!before) return;
            expect(after.equals(before)).toBe(true);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
