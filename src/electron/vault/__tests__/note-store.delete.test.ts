/**
 * Example tests for `NoteStore.delete`.
 *
 * Delete removes `<vault>/notes/<id>.md`, reusing the same path-traversal guard
 * as read/write. The contract:
 *   - deleting an existing note removes exactly that file and returns ok,
 *     leaving other notes untouched;
 *   - deleting an absent id returns `note-not-found` (a stale-id delete is
 *     reported, not a silent no-op) and changes nothing;
 *   - an id that would escape the notes directory is rejected as
 *     `note-not-found` without touching the filesystem;
 *   - a filesystem failure at removal is returned as `delete-failed`.
 *
 * Run against real OS temp dirs (default fs seam), with the fault-injection
 * cases using the `withFs` seam override — matching the sibling store tests.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ResourceNoteInput } from '@shared/resource-note';

import { NoteStore, NOTES_DIR, NOTE_EXT } from '@main/vault/note-store';

let scratch: string;

beforeEach(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'marginalia-delete-'));
});

afterEach(async () => {
  await fs.rm(scratch, { recursive: true, force: true });
});

/** A minimal valid write payload for a given id. */
function inputFor(id: string, title = 'A note'): ResourceNoteInput {
  return {
    id,
    title,
    resource: { type: 'website-link', url: 'https://example.com' },
    content: { prose: 'body', highlights: [] },
  };
}

/** List the note files (`*.md`, non-hidden) in a vault's notes directory. */
async function listNoteFiles(vaultPath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(path.join(vaultPath, NOTES_DIR));
    return entries.filter((n) => n.endsWith(NOTE_EXT) && !n.startsWith('.'));
  } catch {
    return [];
  }
}

describe('NoteStore.delete', () => {
  it('removes an existing note and leaves other notes untouched', async () => {
    const store = new NoteStore();
    expect((await store.write(scratch, inputFor('keep'))).ok).toBe(true);
    expect((await store.write(scratch, inputFor('remove'))).ok).toBe(true);

    const result = await store.delete(scratch, 'remove');

    expect(result.ok).toBe(true);
    // Only the deleted file is gone; the other remains.
    expect(await listNoteFiles(scratch)).toEqual(['keep.md']);
    // Reading the deleted note now reports not-found.
    const read = await store.read(scratch, 'remove');
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.error.code).toBe('note-not-found');
  });

  it('returns note-not-found for an id that was never written, changing nothing', async () => {
    const store = new NoteStore();
    expect((await store.write(scratch, inputFor('present'))).ok).toBe(true);

    const result = await store.delete(scratch, 'absent');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('note-not-found');
    expect(result.error.noteId).toBe('absent');
    // The existing note is untouched.
    expect(await listNoteFiles(scratch)).toEqual(['present.md']);
  });

  it.each(['../escape', '/etc/passwd', 'nested/child', '', '   '])(
    'rejects the path-escaping id %p as note-not-found without touching the filesystem',
    async (id) => {
      // A fully-spying fs seam: any call would be a bug for a guarded id.
      const rm = vi.fn(() => Promise.reject(new Error('should not be called')));
      const readFile = vi.fn(() =>
        Promise.reject(new Error('should not be called')),
      );
      const store = new NoteStore().withFs({ rm, readFile });

      const result = await store.delete(scratch, id);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('note-not-found');
      expect(rm).not.toHaveBeenCalled();
      expect(readFile).not.toHaveBeenCalled();
    },
  );

  it('returns delete-failed when removal errors at the filesystem level', async () => {
    const store = new NoteStore();
    expect((await store.write(scratch, inputFor('boom'))).ok).toBe(true);

    // Force the rm step to reject; the note exists so the guard/existence
    // checks pass and we reach the removal.
    const failing = store.withFs({
      rm: () => Promise.reject(new Error('EPERM')),
    });
    const result = await failing.delete(scratch, 'boom');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('delete-failed');
    expect(result.error.noteId).toBe('boom');
    // The file is still there — a failed delete left it in place.
    expect(await listNoteFiles(scratch)).toEqual(['boom.md']);
  });
});
