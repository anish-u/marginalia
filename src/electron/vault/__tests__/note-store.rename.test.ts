/**
 * Tests for `NoteStore.rename` — renaming a note moves its file so the filename
 * tracks the new title.
 *
 * Contract:
 *   - the file moves from `<old-id>.md` to `<new-slug>.md`; the old file is gone
 *     and the new one is present with the new title;
 *   - `createdAt` is preserved across the move and `modifiedAt` advances;
 *   - renaming to a title whose slug is unchanged is a pure in-place rewrite
 *     (no move, same file);
 *   - a slug collision with a *different* note gets a numeric suffix, but the
 *     note's own current id is never treated as a collision;
 *   - a read error (missing note) is returned verbatim and nothing changes.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ResourceNoteInput } from '@shared/resource-note';

import { NoteStore, NOTES_DIR, NOTE_EXT } from '@main/vault/note-store';

let scratch: string;

beforeEach(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'marginalia-rename-'));
});

afterEach(async () => {
  vi.useRealTimers();
  await fs.rm(scratch, { recursive: true, force: true });
});

function inputFor(id: string, title: string): ResourceNoteInput {
  return {
    id,
    title,
    resource: { type: 'website-link', url: 'https://example.com' },
    content: { prose: 'the body', highlights: [] },
  };
}

async function listNoteFiles(): Promise<string[]> {
  const entries = await fs.readdir(path.join(scratch, NOTES_DIR));
  return entries.filter((n) => n.endsWith(NOTE_EXT) && !n.startsWith('.')).sort();
}

describe('NoteStore.rename', () => {
  it('moves the file to the new title-derived id, preserving content and createdAt', async () => {
    const store = new NoteStore();

    // Create a note at a known id with a controlled createdAt.
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    expect((await store.write(scratch, inputFor('old-slug', 'Old slug'))).ok).toBe(
      true,
    );
    vi.setSystemTime(5_000);

    const result = await store.rename(scratch, 'old-slug', 'Brand New Title');
    vi.useRealTimers();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // New id is the slug of the new title.
    expect(result.value.id).toBe('brand-new-title');
    expect(result.value.title).toBe('Brand New Title');
    // createdAt preserved from the original; modifiedAt advanced.
    expect(result.value.createdAt).toBe(1_000);
    expect(result.value.modifiedAt).toBe(5_000);
    // resource + prose carried over unchanged.
    expect(result.value.resource).toEqual({
      type: 'website-link',
      url: 'https://example.com',
    });
    expect(result.value.content.prose).toBe('the body');

    // On disk: only the new file exists.
    expect(await listNoteFiles()).toEqual(['brand-new-title.md']);

    // The old id no longer reads; the new id does.
    const oldRead = await store.read(scratch, 'old-slug');
    expect(oldRead.ok).toBe(false);
    const newRead = await store.read(scratch, 'brand-new-title');
    expect(newRead.ok).toBe(true);
  });

  it('is an in-place rewrite when the slug is unchanged (no move)', async () => {
    const store = new NoteStore();
    expect((await store.write(scratch, inputFor('my-note', 'My Note'))).ok).toBe(
      true,
    );

    // "my note" and "My Note!" both slug to `my-note` → same id, no move.
    const result = await store.rename(scratch, 'my-note', 'My Note!');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.id).toBe('my-note');
    expect(result.value.title).toBe('My Note!');
    expect(await listNoteFiles()).toEqual(['my-note.md']);
  });

  it('disambiguates against a different note but not against itself', async () => {
    const store = new NoteStore();
    // Two notes: `report` and `notes`.
    expect((await store.write(scratch, inputFor('report', 'Report'))).ok).toBe(
      true,
    );
    expect((await store.write(scratch, inputFor('notes', 'Notes'))).ok).toBe(
      true,
    );

    // Rename `notes` → "Report": collides with the existing `report` → `report-2`.
    const collide = await store.rename(scratch, 'notes', 'Report');
    expect(collide.ok).toBe(true);
    if (!collide.ok) return;
    expect(collide.value.id).toBe('report-2');
    expect(await listNoteFiles()).toEqual(['report-2.md', 'report.md']);

    // Rename `report-2` → "Report" again: its own current id must NOT be treated
    // as a collision. `report` is taken (the other note), so it stays `report-2`.
    const self = await store.rename(scratch, 'report-2', 'Report');
    expect(self.ok).toBe(true);
    if (!self.ok) return;
    expect(self.value.id).toBe('report-2');
    expect(await listNoteFiles()).toEqual(['report-2.md', 'report.md']);
  });

  it('returns the read error verbatim for a missing note and changes nothing', async () => {
    const store = new NoteStore();
    expect((await store.write(scratch, inputFor('present', 'Present'))).ok).toBe(
      true,
    );

    const result = await store.rename(scratch, 'absent', 'Whatever');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('note-not-found');
    // The existing note is untouched.
    expect(await listNoteFiles()).toEqual(['present.md']);
  });

  it('leaves the original file intact if writing the new file fails', async () => {
    const store = new NoteStore();
    expect((await store.write(scratch, inputFor('keep', 'Keep'))).ok).toBe(true);

    // Force the atomic commit (rename of the temp file) to fail during the move.
    const failing = store.withFs({
      rename: () => Promise.reject(new Error('boom')),
    });
    const result = await failing.rename(scratch, 'keep', 'Moved Away');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('write-failed');
    // The original note is still there under its old id (non-destructive).
    expect(await listNoteFiles()).toEqual(['keep.md']);
    expect((await store.read(scratch, 'keep')).ok).toBe(true);
  });
});
