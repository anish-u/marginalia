/**
 * Tests for title-derived note ids: `slugify` and `NoteStore.allocateId`.
 *
 * New notes get a filename derived from their title so the on-disk file is
 * recognizable (`my-research-notes.md`). The id must be a filesystem-safe stem
 * that passes the store's path-traversal guard, and duplicate titles must not
 * collide — the second gets a numeric suffix. A blank title falls back to a
 * slug of the default title.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ResourceNoteInput } from '@shared/resource-note';

import {
  DEFAULT_TITLE,
  NoteStore,
  NOTES_DIR,
  NOTE_EXT,
  slugify,
} from '@main/vault/note-store';

let scratch: string;

beforeEach(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'marginalia-allocate-'));
});

afterEach(async () => {
  await fs.rm(scratch, { recursive: true, force: true });
});

function inputFor(id: string, title: string): ResourceNoteInput {
  return {
    id,
    title,
    resource: { type: 'website-link', url: 'https://example.com' },
    content: { prose: 'body', highlights: [] },
  };
}

describe('slugify', () => {
  it.each([
    ['My Research Notes', 'my-research-notes'],
    ['  Trim  Me  ', 'trim-me'],
    ['Special!@#$%Chars', 'special-chars'],
    ['café déjà vu', 'cafe-deja-vu'],
    ['---leading/trailing---', 'leading-trailing'],
    ['Multiple   Spaces', 'multiple-spaces'],
  ])('slugifies %p → %p', (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });

  it('returns empty string for a title with no sluggable characters', () => {
    expect(slugify('!!!')).toBe('');
    expect(slugify('   ')).toBe('');
  });

  it('produces a stem that has no path separators or dot-segments', () => {
    const slug = slugify('../../etc/passwd');
    expect(slug).not.toContain('/');
    expect(slug).not.toContain('\\');
    expect(slug.startsWith('.')).toBe(false);
    expect(slug).toBe('etc-passwd');
  });
});

describe('NoteStore.allocateId', () => {
  it('derives the id from the title', async () => {
    const store = new NoteStore();
    expect(await store.allocateId(scratch, 'My Research Notes')).toBe(
      'my-research-notes',
    );
  });

  it('falls back to the default-title slug for a blank title', async () => {
    const store = new NoteStore();
    const expected = slugify(DEFAULT_TITLE);
    expect(await store.allocateId(scratch, '')).toBe(expected);
    expect(await store.allocateId(scratch, '   ')).toBe(expected);
  });

  it('appends a numeric suffix when the slug is already taken', async () => {
    const store = new NoteStore();
    // Seed an existing note whose filename stem is `notes`.
    expect((await store.write(scratch, inputFor('notes', 'Notes'))).ok).toBe(
      true,
    );

    // A new note titled "Notes" can't reuse `notes` → gets `notes-2`.
    expect(await store.allocateId(scratch, 'Notes')).toBe('notes-2');

    // Seed `notes-2` too; the next allocation skips to `notes-3`.
    expect((await store.write(scratch, inputFor('notes-2', 'Notes'))).ok).toBe(
      true,
    );
    expect(await store.allocateId(scratch, 'Notes')).toBe('notes-3');
  });

  it('collision check is case-insensitive (matches case-insensitive filesystems)', async () => {
    const store = new NoteStore();
    expect((await store.write(scratch, inputFor('report', 'Report'))).ok).toBe(
      true,
    );
    // "REPORT" slugs to `report`, which collides with the existing file on a
    // case-insensitive FS → disambiguated.
    expect(await store.allocateId(scratch, 'REPORT')).toBe('report-2');
  });

  it('allocated ids resolve to a flat file directly inside notes/', async () => {
    const store = new NoteStore();
    const id = await store.allocateId(scratch, 'Anything Goes Here');
    // A write with the allocated id must land as <vault>/notes/<id>.md and be
    // readable back — proving the id passes the path guard.
    expect((await store.write(scratch, inputFor(id, 'Anything Goes Here'))).ok).toBe(
      true,
    );
    const entries = await fs.readdir(path.join(scratch, NOTES_DIR));
    expect(entries).toContain(`${id}${NOTE_EXT}`);
  });
});
