// Feature: vault-and-notes, Property 8: Write sets timestamps correctly
// Feature: vault-and-notes, Property 9: Overwrite is in place (one file per id)
// Feature: vault-and-notes, Property 7: Empty/whitespace titles are stored as the default

/**
 * Property-based tests for `NoteStore.write`, exercised over *real* temp
 * directories under `os.tmpdir()` (design → Testing Strategy: the store owns
 * the filesystem concerns precisely so it can be property-tested against a live
 * folder without an Electron window). Persistence is verified through the
 * store's own `read()` and by enumerating the notes directory with `readdir`.
 *
 * Three laws are under test:
 *
 *   Property 8 (Write sets timestamps correctly, Req 5.4): on write,
 *   `modifiedAt` is the system clock at write start; on the *first* write
 *   `createdAt` equals `modifiedAt`; on an *overwrite* `createdAt` is preserved
 *   from the existing file while `modifiedAt` advances to the new write clock.
 *   The clock is controlled with `vi.useFakeTimers()` / `vi.setSystemTime()`
 *   (the store reads `Date.now()` at write start) so first-write equality and
 *   overwrite advancement are asserted deterministically.
 *
 *   Property 9 (Overwrite is in place, Req 5.3): writing a note whose id
 *   already exists overwrites that file in place and never creates an
 *   additional file — after any number of writes to a given id the notes
 *   directory holds exactly one `<id>.md` for it (temp files from the atomic
 *   commit are cleaned up / never counted).
 *
 *   Property 7 (Empty/whitespace titles are stored as the default, Req 5.7):
 *   writing a note whose title is empty or whitespace-only persists the default
 *   title (`DEFAULT_TITLE`), and reading the file back yields that default —
 *   never the blank input. A non-blank title is stored verbatim.
 *
 * Validates: Requirements 5.7, 5.4, 4.7, 5.3
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
// Namespace import: fast-check re-exports helpers as named exports *and* a
// default namespace, so `import fc from 'fast-check'` + `fc.string()` trips
// eslint-plugin-import's no-named-as-default-member rule. `* as` keeps the
// conventional `fc.` call sites warning-free (matching the sibling tests).
import * as fc from 'fast-check';

import type {
  ResourceNoteInput,
  WebsiteLinkResource,
} from '@shared/resource-note';

import {
  DEFAULT_TITLE,
  NOTES_DIR,
  NOTE_EXT,
  NoteStore,
} from '@main/vault/note-store';

/**
 * Track every temp vault dir created during the run so we can clean them all up
 * afterwards.
 *
 * Each fast-check property runs ~100 times; a *single* shared scratch dir with
 * vault sub-folders whose names are derived from generated ids does NOT isolate
 * the runs. On a case-insensitive temp volume (macOS APFS is case-preserving
 * but case-*insensitive*) two ids differing only in case fold to the same path,
 * so note files written under one run's vault leak into another run's vault and
 * the file-count / file-name assertions fail intermittently. The fix is to give
 * every property RUN its own fresh, unique directory via `fs.mkdtemp` (matching
 * the sibling `note-store.list.test.ts` / `note-store.write-fail.test.ts`), so
 * no two runs — or tests — ever share a directory.
 */
const createdDirs: string[] = [];

/**
 * Make a fresh, isolated temp vault directory for one property run. The unique
 * `mkdtemp` suffix (never a generated id) guarantees runs cannot collide, even
 * on a case-insensitive filesystem.
 *
 * Callers that install fake timers (Property 8) MUST create the vault *before*
 * `vi.useFakeTimers()` — `mkdtemp` is a real async fs call and we keep it on
 * real time.
 */
async function makeVaultDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'marginalia-notestore-'));
  createdDirs.push(dir);
  return dir;
}

afterEach(async () => {
  // Restore real timers in case a test installed fake ones (idempotent when
  // none were installed).
  vi.useRealTimers();
  // Best-effort cleanup of every temp vault created so far.
  await Promise.all(
    createdDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

/** Absolute path to a vault's notes directory. */
function notesDirOf(vaultPath: string): string {
  return path.join(vaultPath, NOTES_DIR);
}

/**
 * Enumerate the note *files* (`*.md`, non-hidden) in a vault's notes directory.
 * Mirrors the store's own filter: temp files from the atomic commit are hidden
 * (`.<id>.<ts>.tmp`) and must never be counted as notes. Returns [] when the
 * notes directory does not exist yet.
 */
async function listNoteFiles(vaultPath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(notesDirOf(vaultPath));
    return entries.filter(
      (name) => name.endsWith(NOTE_EXT) && !name.startsWith('.'),
    );
  } catch {
    return [];
  }
}

/** Valid http/https website-link resource (Req 4.3). */
const websiteLinkArb: fc.Arbitrary<WebsiteLinkResource> = fc
  .webUrl()
  .map((url) => ({ type: 'website-link', url }));

/** A filesystem-safe note id (flat stem under notes/, no separators/dots). */
const idArb = fc
  .stringMatching(/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/)
  .filter((s) => s.length > 0);

/** A non-blank title (has at least one non-whitespace character). */
const nonBlankTitleArb = fc
  .string({ unit: 'binary', maxLength: 255 })
  .filter((s) => s.trim() !== '');

/** A blank/whitespace-only title: empty string or only spaces/tabs/newlines. */
const blankTitleArb = fc.oneof(
  fc.constant(''),
  fc
    .array(fc.constantFrom(' ', '\t', '\n'), { minLength: 1, maxLength: 8 })
    .map((chars) => chars.join('')),
);

/** Build a `ResourceNoteInput` (the shape callers hand to `write`). */
function inputArb(overrides?: {
  id?: fc.Arbitrary<string>;
  title?: fc.Arbitrary<string>;
}): fc.Arbitrary<ResourceNoteInput> {
  return fc.record({
    id: overrides?.id ?? idArb,
    title: overrides?.title ?? nonBlankTitleArb,
    resource: websiteLinkArb,
    content: fc.record({
      prose: fc.string({ unit: 'binary', maxLength: 200 }).filter(
        // Exclude prose the on-disk envelope cannot represent byte-for-byte, so
        // read-back comparisons of content are meaningful (documented in
        // note-file.test.ts). This suffices for the timestamp/overwrite/title
        // laws under test here.
        (s) =>
          !s.includes('\r') &&
          !s.startsWith('\n') &&
          !s.split('\n').some((line) => line === '---'),
      ),
      highlights: fc.constant([]),
    }),
  });
}

describe('NoteStore.write timestamps (Property 8)', () => {
  it('first write sets createdAt === modifiedAt === the write-start clock', async () => {
    await fc.assert(
      fc.asyncProperty(
        inputArb(),
        // A deterministic write-start clock (epoch ms) controlled via fake timers.
        fc.integer({ min: 0, max: 4_102_444_800_000 }),
        async (input, clock) => {
          // Fresh unique dir per run (created on real time, before faking).
          const vault = await makeVaultDir();
          const store = new NoteStore();

          vi.useFakeTimers();
          vi.setSystemTime(clock);

          const result = await store.write(vault, input);

          vi.useRealTimers();

          expect(result.ok).toBe(true);
          if (!result.ok) return;
          // Both timestamps are the write-start clock on a first write (Req 5.4).
          expect(result.value.createdAt).toBe(clock);
          expect(result.value.modifiedAt).toBe(clock);

          // And the same holds when read back from disk (persisted, not just
          // returned).
          const read = await store.read(vault, input.id);
          expect(read.ok).toBe(true);
          if (!read.ok) return;
          expect(read.value.createdAt).toBe(clock);
          expect(read.value.modifiedAt).toBe(clock);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('overwrite preserves createdAt but advances modifiedAt to the new write clock', async () => {
    await fc.assert(
      fc.asyncProperty(
        inputArb(),
        inputArb(),
        // Two distinct clocks: the second is strictly later so modifiedAt must move.
        fc.integer({ min: 0, max: 2_000_000_000_000 }),
        fc.integer({ min: 1, max: 2_000_000_000_000 }),
        async (first, second, firstClock, delta) => {
          const secondClock = firstClock + delta; // strictly after the first write
          // Fresh unique dir per run (created on real time, before faking).
          const vault = await makeVaultDir();
          const store = new NoteStore();

          // Overwrite targets the SAME id (the second input keeps its own title,
          // resource, content but reuses the first note's id).
          const overwrite: ResourceNoteInput = { ...second, id: first.id };

          vi.useFakeTimers();
          vi.setSystemTime(firstClock);
          const firstResult = await store.write(vault, first);
          expect(firstResult.ok).toBe(true);

          vi.setSystemTime(secondClock);
          const secondResult = await store.write(vault, overwrite);
          vi.useRealTimers();

          expect(secondResult.ok).toBe(true);
          if (!secondResult.ok) return;
          // createdAt is preserved from the first write (Req 5.4) …
          expect(secondResult.value.createdAt).toBe(firstClock);
          // … while modifiedAt advances to the overwrite's write-start clock.
          expect(secondResult.value.modifiedAt).toBe(secondClock);

          // Read back confirms the persisted timestamps match.
          const read = await store.read(vault, first.id);
          expect(read.ok).toBe(true);
          if (!read.ok) return;
          expect(read.value.createdAt).toBe(firstClock);
          expect(read.value.modifiedAt).toBe(secondClock);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('NoteStore.write is in place — one file per id (Property 9)', () => {
  it('overwriting a given id repeatedly yields exactly one file for that id', async () => {
    await fc.assert(
      fc.asyncProperty(
        idArb,
        // A handful of successive writes to the same id (2..5 writes).
        fc.array(inputArb(), { minLength: 2, maxLength: 5 }),
        async (id, writes) => {
          const vault = await makeVaultDir();
          const store = new NoteStore();

          for (const w of writes) {
            const res = await store.write(vault, { ...w, id });
            expect(res.ok).toBe(true);
          }

          // Exactly one note file exists overall, and it is `<id>.md`.
          const files = await listNoteFiles(vault);
          expect(files).toEqual([`${id}${NOTE_EXT}`]);
          // No leftover temp files from the atomic commit either.
          const allEntries = await fs.readdir(notesDirOf(vault));
          expect(allEntries.filter((n) => n.endsWith('.tmp'))).toEqual([]);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('distinct ids each produce their own single file (no cross-clobbering)', async () => {
    await fc.assert(
      fc.asyncProperty(
        // A set of unique ids. Uniqueness is enforced *case-insensitively*
        // (selector lowercases each id): note ids are opaque filename stems, so
        // on a case-insensitive filesystem (macOS default) two ids differing
        // only in case (e.g. `r` vs `R`) resolve to the same `<id>.md` file and
        // the second write overwrites the first — yielding one file, not two.
        // Lowercasing the uniqueness key keeps the generated set distinct on
        // both case-sensitive and case-insensitive filesystems, which is the
        // correct cross-platform invariant to assert here.
        fc.uniqueArray(idArb, {
          minLength: 1,
          maxLength: 5,
          selector: (id) => id.toLowerCase(),
        }),
        async (ids) => {
          const vault = await makeVaultDir();
          const store = new NoteStore();

          for (const id of ids) {
            const res = await store.write(vault, {
              id,
              title: 'note',
              resource: { type: 'website-link', url: 'https://example.com' },
              content: { prose: 'body', highlights: [] },
            });
            expect(res.ok).toBe(true);
          }

          // One file per distinct id, exactly.
          const files = await listNoteFiles(vault);
          expect(files.slice().sort()).toEqual(
            ids.map((id) => `${id}${NOTE_EXT}`).sort(),
          );
          expect(files.length).toBe(ids.length);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('NoteStore.write default title (Property 7)', () => {
  it('a blank/whitespace title is persisted and read back as the default title', async () => {
    await fc.assert(
      fc.asyncProperty(
        inputArb({ title: blankTitleArb }),
        async (input) => {
          const vault = await makeVaultDir();
          const store = new NoteStore();

          const result = await store.write(vault, input);
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          // The returned note carries the default title, never the blank input.
          expect(result.value.title).toBe(DEFAULT_TITLE);

          // And the persisted file reads back as the default (not the blank).
          const read = await store.read(vault, input.id);
          expect(read.ok).toBe(true);
          if (!read.ok) return;
          expect(read.value.title).toBe(DEFAULT_TITLE);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('a non-blank title is stored verbatim (default is not applied)', async () => {
    await fc.assert(
      fc.asyncProperty(
        inputArb({ title: nonBlankTitleArb }),
        async (input) => {
          const vault = await makeVaultDir();
          const store = new NoteStore();

          const result = await store.write(vault, input);
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          expect(result.value.title).toBe(input.title);

          const read = await store.read(vault, input.id);
          expect(read.ok).toBe(true);
          if (!read.ok) return;
          expect(read.value.title).toBe(input.title);
        },
      ),
      { numRuns: 100 },
    );
  });
});
