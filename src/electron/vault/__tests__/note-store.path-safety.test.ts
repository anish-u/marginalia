// Feature: vault-and-notes, path-traversal safety guard (Error Handling → path safety)

/**
 * Property-based test for the Note_Store's path-traversal safety guard.
 *
 * The renderer identifies notes by an opaque `id`, never by an absolute path,
 * so a malicious or buggy renderer must not be able to coerce the store into
 * reading or writing a file outside `<vault>/notes/`. This upholds the
 * least-privilege posture in the steering rules (Error Handling → path safety).
 *
 * The law under test:
 *
 *   For any id that would escape the notes directory — `../`-style traversal,
 *   an absolute path (`/etc/passwd`), a Windows-style `..\\evil`, a nested
 *   separator (`nested/child`), or an empty/whitespace id — both `write` and
 *   `read`:
 *     1. reject the id (write → `write-failed`, read → `note-not-found`), and
 *     2. NEVER touch the filesystem for it — no mutating fs method (writeFile,
 *        rename, mkdir, rm) and no reading fs method (readFile, readdir) is
 *        called at all.
 *
 * Assertion strategy: rather than only checking that no path *outside* the
 * notes directory is passed to fs, we make the stronger, cleaner claim that a
 * guarded id causes **zero fs calls**. The guard runs before any I/O, so a
 * rejected id has no legitimate reason to reach the seam at all. We install a
 * fully-spying `NoteStoreFs` via `store.withFs({...})` whose every method both
 * records its arguments and rejects/throws, so if the guard ever failed to
 * short-circuit we would observe both the errant call and (belt and braces) a
 * path escaping `<vault>/notes/`.
 *
 * Validates: Error Handling → path safety (upholds least-privilege posture)
 */

import * as path from 'node:path';

import { describe, expect, it, vi } from 'vitest';
// Namespace import: fast-check re-exports helpers as named *and* default
// exports, so `import fc from 'fast-check'` + `fc.string()` trips
// eslint-plugin-import's no-named-as-default-member rule. `* as` keeps the
// conventional `fc.` call sites warning-free (matches note-file.test.ts).
import * as fc from 'fast-check';

import type { ResourceNoteInput } from '@shared/resource-note';

import { NoteStore, type NoteStoreFs } from '@main/vault/note-store';

/** A fixed, absolute vault root used across the property. */
const VAULT = path.resolve('/tmp/marginalia-test-vault');

/** The one directory a well-behaved write is ever allowed to touch. */
const NOTES_DIR = path.resolve(VAULT, 'notes');

/**
 * A minimal, valid write payload for a given id. The path guard runs on `id`
 * before any field of `content`/`resource` matters, so the rest is arbitrary
 * but well-formed.
 */
function inputFor(id: string): ResourceNoteInput {
  return {
    id,
    title: 'irrelevant',
    resource: { type: 'website-link', url: 'https://example.com' },
    content: { prose: '', highlights: [] },
  };
}

/**
 * Build a fully-spying fs seam. Every method records its calls (via `vi.fn`)
 * and then rejects/throws, so:
 *   - a guarded id must produce ZERO recorded calls (the guard short-circuits
 *     before any I/O), and
 *   - if the guard ever regressed, the rejection guarantees the operation still
 *     fails loudly rather than silently succeeding against real disk.
 */
function spyingFs(): NoteStoreFs {
  const boom = (name: string) => () =>
    Promise.reject(new Error(`fs.${name} must not be called for a guarded id`));
  return {
    mkdir: vi.fn(boom('mkdir')),
    readFile: vi.fn(boom('readFile')),
    writeFile: vi.fn(boom('writeFile')),
    rename: vi.fn(boom('rename')),
    rm: vi.fn(boom('rm')),
    readdir: vi.fn(boom('readdir')),
  };
}

/**
 * Collect every filesystem *path* argument passed to any spied fs method.
 *
 * Only the leading positional arguments that name a path are collected —
 * `writeFile(file, data, enc)` and `readFile(file, enc)` also pass non-path
 * strings (the file contents, the `'utf8'` encoding) which must NOT be treated
 * as paths, and `rename(old, new)` passes *two* paths. We therefore whitelist
 * the path-argument positions per method rather than scooping up every string.
 */
function allPathArgs(fs: NoteStoreFs): string[] {
  // Which positional args of each seam method are filesystem paths.
  const pathArgIndices: Record<keyof NoteStoreFs, number[]> = {
    mkdir: [0],
    readFile: [0],
    writeFile: [0],
    rename: [0, 1],
    rm: [0],
    readdir: [0],
  };
  const paths: string[] = [];
  for (const [name, method] of Object.entries(fs) as Array<
    [keyof NoteStoreFs, { mock?: { calls: unknown[][] } }]
  >) {
    const calls = method.mock?.calls;
    if (!calls) continue;
    for (const call of calls) {
      for (const idx of pathArgIndices[name]) {
        const arg = call[idx];
        if (typeof arg === 'string') paths.push(arg);
      }
    }
  }
  return paths;
}

/** Total number of fs method invocations across the whole seam. */
function totalFsCalls(fs: NoteStoreFs): number {
  return (Object.values(fs) as Array<{ mock?: { calls: unknown[][] } }>).reduce(
    (sum, method) => sum + (method.mock?.calls.length ?? 0),
    0,
  );
}

/**
 * Malicious / escaping ids that the guard MUST reject on every platform.
 *
 * These are drawn from the documented attack classes in the task —
 * `../`-traversal, POSIX absolute paths, nested separators, and
 * empty/whitespace ids. Every case here uses the POSIX path separator (`/`) or
 * is empty/whitespace, so each genuinely resolves outside (or fails to resolve
 * to a flat child of) `<vault>/notes/` regardless of the host OS.
 *
 * A note on Windows-style `..\\evil`: on POSIX — where these tests run — the
 * backslash is a *legal filename character*, so `..\\evil` is a single flat
 * filename that lives directly inside `notes/` and does NOT escape. It is
 * therefore correctly *permitted* by the guard on POSIX (and would be rejected
 * on Windows, where `\\` is a separator). Because its classification is
 * platform-dependent, `..\\evil` is exercised separately in the "backslash is a
 * flat filename on POSIX" test below rather than asserted as always-rejected
 * here — asserting a fixed outcome for it would encode a platform-specific
 * assumption into a cross-platform property.
 */
const escapingIdArb: fc.Arbitrary<string> = fc.oneof(
  // Parent-directory traversal: at least one `..` segment followed by a
  // separator and a payload, so the id always contains a `/` and genuinely
  // climbs out of notes/ (e.g. `../evil`, `../../etc/passwd`). A *bare* `..`
  // with no separator is deliberately excluded here: on POSIX `..` + `.md`
  // resolves to the flat filename `...md` inside notes/ (it does NOT escape),
  // so it belongs with the permitted flat ids, not the guaranteed-rejected set.
  fc
    .array(fc.constant('..'), { minLength: 1, maxLength: 4 })
    .chain((ups) =>
      fc
        .constantFrom('evil', 'secret', 'etc/passwd', 'notes/../escape')
        .map((tail) => [...ups, tail].join('/')),
    ),
  // POSIX absolute paths.
  fc.constantFrom('/etc/passwd', '/etc/shadow', '/root/.ssh/id_rsa', '/tmp/x'),
  // Nested separators (would create a subdirectory — not a flat note file).
  fc.constantFrom('nested/child', 'a/b/c', 'sub/../../escape', 'foo/bar'),
  // Embedded traversal within an otherwise-normal-looking id.
  fc.constantFrom('note/../../etc/passwd', 'x/../../../y'),
  // Empty and whitespace-only ids (rejected outright by the guard).
  fc.constantFrom('', ' ', '   ', '\t', '\n', ' \t \n '),
);

/** Assert a resolved path argument stays within `<vault>/notes/`. */
function expectInsideNotesDir(p: string): void {
  const resolved = path.resolve(p);
  const inside = resolved === NOTES_DIR || resolved.startsWith(NOTES_DIR + path.sep);
  expect(inside).toBe(true);
}

describe('Note_Store path-traversal safety guard', () => {
  it('write rejects escaping ids with write-failed and never touches the filesystem', async () => {
    await fc.assert(
      fc.asyncProperty(escapingIdArb, async (id) => {
        const fs = spyingFs();
        const store = new NoteStore().withFs(fs);

        const result = await store.write(VAULT, inputFor(id));

        // Rejected as a write failure naming the offending id.
        expect(result.ok).toBe(false);
        if (result.ok) return; // narrow for TS
        expect(result.error.code).toBe('write-failed');
        expect(result.error.noteId).toBe(id);

        // Strong claim: zero fs calls at all for a guarded id.
        expect(totalFsCalls(fs)).toBe(0);

        // Belt and braces: had any call slipped through, none of its path
        // arguments may live outside <vault>/notes/.
        allPathArgs(fs).forEach(expectInsideNotesDir);
      }),
      { numRuns: 200 },
    );
  });

  it('read rejects escaping ids with note-not-found and never touches the filesystem', async () => {
    await fc.assert(
      fc.asyncProperty(escapingIdArb, async (id) => {
        const fs = spyingFs();
        const store = new NoteStore().withFs(fs);

        const result = await store.read(VAULT, id);

        // Rejected as a non-destructive miss naming the offending id.
        expect(result.ok).toBe(false);
        if (result.ok) return; // narrow for TS
        expect(result.error.code).toBe('note-not-found');
        expect(result.error.noteId).toBe(id);

        // Zero fs calls for a guarded id (no readFile, no readdir).
        expect(totalFsCalls(fs)).toBe(0);

        allPathArgs(fs).forEach(expectInsideNotesDir);
      }),
      { numRuns: 200 },
    );
  });

  it('sanity: a well-formed flat id is NOT rejected by the guard (it reaches the fs seam)', async () => {
    // Guards against a false-positive test: if the guard rejected *everything*,
    // the properties above would pass vacuously. A legitimate id must pass the
    // guard and reach the seam (where our spy then makes the op fail). It must
    // also only ever touch paths inside <vault>/notes/.
    const fs = spyingFs();
    const store = new NoteStore().withFs(fs);

    await store.read(VAULT, 'note-2024-earthquake');

    // A legitimate id DOES reach the fs seam (readFile is attempted)...
    expect(totalFsCalls(fs)).toBeGreaterThan(0);
    // ...and only ever inside the notes directory.
    allPathArgs(fs).forEach(expectInsideNotesDir);
  });

  it('treats a backslash id as a flat filename on POSIX (never escapes notes/)', async () => {
    // On POSIX the backslash is a legal filename character, so `..\\evil` is a
    // single flat file *inside* notes/ — the guard permits it and it reaches
    // the fs seam. On Windows the same id contains a separator and would be
    // rejected. Either way the invariant that matters holds: no fs path ever
    // escapes <vault>/notes/. We assert only that invariant so this test is
    // correct on every platform.
    const fs = spyingFs();
    const store = new NoteStore().withFs(fs);

    await store.read(VAULT, '..\\evil');

    // The security-relevant invariant: nothing outside notes/ is ever touched,
    // regardless of whether the id was permitted (POSIX) or rejected (Windows).
    allPathArgs(fs).forEach(expectInsideNotesDir);
  });
});
