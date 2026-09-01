// Feature: vault-and-notes, Property 10: Failed writes leave the prior file byte-unchanged

/**
 * Property-based test for the atomic-write failure contract (Req 5.5,
 * Property 10). The law under test:
 *
 *   If a note was previously written successfully, and a subsequent overwrite
 *   of that id fails at the commit (`rename`) step, then:
 *     - the on-disk file is byte-for-byte identical to what it was before the
 *       failed write (the prior file is left untouched), and
 *     - the write result is `{ ok: false, error: { code: 'write-failed',
 *       noteId: <id> } }` naming the affected id, and
 *     - no orphan temp files are left behind — the store best-effort removes the
 *       temp file it wrote, so the notes directory still contains exactly the
 *       one `<id>.md`.
 *
 * The atomic-write protocol writes the serialized note to a temp file *in the
 * same directory* as the target, then `rename`s it over the target. The commit
 * is the `rename`. Forcing `rename` to reject therefore simulates a commit
 * failure after the (harmless) temp file has been written — precisely the
 * window in which the prior committed file must survive intact.
 *
 * We exercise this against a *real* OS temp directory (default fs seam) for the
 * first, successful write so the "prior file" is genuine on-disk bytes. The
 * failing overwrite uses `store.withFs({ rename: reject })` — a thin fs seam
 * override that forces only the commit step to error while every other fs call
 * (mkdir, readFile, writeFile, rm, readdir) runs against real disk. This keeps
 * the fault injection surgical: the failure is exactly at the commit, not
 * somewhere the contract doesn't cover.
 *
 * Property 10 — Validates: Requirements 5.5
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';
// Namespace import: fast-check re-exports helpers as named exports *and* a
// default namespace, so `import fc from 'fast-check'` trips
// eslint-plugin-import's no-named-as-default-member rule. `* as` keeps the
// conventional `fc.` call sites warning-free (matches note-file.test.ts).
import * as fc from 'fast-check';

import type {
  ResourceNoteInput,
  WebsiteLinkResource,
} from '@shared/resource-note';

import { NoteStore, NOTES_DIR, NOTE_EXT } from '@main/vault/note-store';

/** Track temp vault dirs so we can clean them all up after the suite. */
const createdDirs: string[] = [];

/** Make a fresh, isolated temp vault directory for one property run. */
async function makeVaultDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'marginalia-writefail-'));
  createdDirs.push(dir);
  return dir;
}

afterAll(async () => {
  // Best-effort cleanup of every temp vault created during the run.
  await Promise.all(
    createdDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

/** Valid http/https website-link resource (the implemented variant). */
const websiteLinkArb: fc.Arbitrary<WebsiteLinkResource> = fc
  .webUrl()
  .map((url) => ({ type: 'website-link', url }));

/**
 * A single highlight — arbitrary text/prefix/suffix (unicode-inclusive), a
 * valid url, and a finite epoch-ms createdAt. Mirrors the note-file arbitrary so
 * the serialized bytes vary widely across runs.
 */
const highlightArb = fc.record({
  id: fc.string({ minLength: 1, maxLength: 24 }),
  text: fc.string({ unit: 'binary', maxLength: 120 }),
  prefix: fc.string({ unit: 'binary', maxLength: 40 }),
  suffix: fc.string({ unit: 'binary', maxLength: 40 }),
  url: fc.webUrl(),
  createdAt: fc.integer({ min: 0, max: 4_102_444_800_000 }),
});

/**
 * Opaque Markdown prose the on-disk envelope represents byte-for-byte. Excludes
 * the same envelope-imposed edge cases characterized in note-file.test.ts (CR
 * normalization, an absorbed leading blank line, and a bare `---` line) so the
 * "successful first write then re-read" baseline is stable and unambiguous.
 */
const proseArb = fc
  .string({ unit: 'binary', maxLength: 300 })
  .filter((s) => {
    if (s.includes('\r')) return false;
    if (s.startsWith('\n')) return false;
    if (s.split('\n').some((line) => line === '---')) return false;
    return true;
  });

/**
 * Varied note *content* to write. Ids are constrained to safe, flat filename
 * stems (no separators, no dots, non-empty) so they pass the store's
 * path-traversal guard and the successful baseline write always lands — the
 * guard itself is Property covered by task 4.2, not here.
 */
const noteInputArb: fc.Arbitrary<ResourceNoteInput> = fc.record({
  id: fc
    .string({ minLength: 1, maxLength: 24 })
    // Keep to a conservative flat-filename alphabet: the guard rejects
    // separators/`..`, and we want the baseline write to succeed every run.
    .map((s) => s.replace(/[^A-Za-z0-9_-]/g, '_'))
    .filter((s) => s.length > 0 && s !== '.' && s !== '..'),
  title: fc.string({ unit: 'binary', maxLength: 120 }),
  resource: websiteLinkArb,
  content: fc.record({
    prose: proseArb,
    highlights: fc.array(highlightArb, { maxLength: 5 }),
  }),
});

/**
 * A second, *different* payload to attempt as the failing overwrite, so the
 * bytes we try to commit differ from the prior file (making a silent partial
 * write detectable). Reuses the same content generators; the id is overwritten
 * with the baseline id at the call site.
 */
const overwriteContentArb = fc.record({
  title: fc.string({ unit: 'binary', maxLength: 120 }),
  resource: websiteLinkArb,
  content: fc.record({
    prose: proseArb,
    highlights: fc.array(highlightArb, { maxLength: 5 }),
  }),
});

describe('note-store failed writes (Property 10)', () => {
  it('a failed commit leaves the prior file byte-for-byte unchanged and returns write-failed', async () => {
    await fc.assert(
      fc.asyncProperty(
        noteInputArb,
        overwriteContentArb,
        async (input, overwrite) => {
          const vaultPath = await makeVaultDir();
          const notesDir = path.join(vaultPath, NOTES_DIR);
          const filePath = path.join(notesDir, `${input.id}${NOTE_EXT}`);

          // 1. Successful first write with the real (default) fs seam. This
          //    establishes a genuine on-disk "prior file".
          const store = new NoteStore();
          const first = await store.write(vaultPath, input);
          expect(first.ok).toBe(true);

          // Capture the prior file's exact bytes for a byte-for-byte comparison.
          const before = await fs.readFile(filePath);

          // 2. Attempt an overwrite of the SAME id with different content, using
          //    a store whose commit step (`rename`) is forced to reject. Only
          //    the commit fails; the temp file is still written to real disk.
          const failing = store.withFs({
            rename: () => Promise.reject(new Error('boom')),
          });
          const result = await failing.write(vaultPath, {
            id: input.id,
            title: overwrite.title,
            resource: overwrite.resource,
            content: overwrite.content,
          });

          // The result is a write-failed error naming the affected id.
          expect(result.ok).toBe(false);
          if (result.ok) return; // narrows for TS; assertion above already failed.
          expect(result.error.code).toBe('write-failed');
          expect(result.error.noteId).toBe(input.id);

          // 3. The prior file is byte-for-byte unchanged.
          const after = await fs.readFile(filePath);
          expect(after.equals(before)).toBe(true);

          // 4. No orphan temp files remain: the notes dir holds exactly the one
          //    `<id>.md` — the best-effort `rm` cleaned up the temp sibling.
          const entries = await fs.readdir(notesDir);
          expect(entries).toEqual([`${input.id}${NOTE_EXT}`]);
        },
      ),
      { numRuns: 100 },
    );
  });
});
