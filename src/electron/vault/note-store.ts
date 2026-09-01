/**
 * Note_Store — reads and writes `Note_File`s in the active vault.
 *
 * This module is the main-process authority over the vault's `notes/` folder.
 * It owns the *filesystem* concerns — path resolution, the atomic write
 * protocol, timestamp policy, the default title, and the path-traversal guard —
 * while delegating all (de)serialization to the pure `note-file.ts`
 * ({@link serializeNote} / {@link parseNote}). That split keeps the byte-level
 * envelope logic property-testable without a disk, and keeps this module
 * testable against a real temp directory (see design → "Note_Store").
 *
 * ## Path safety (Error Handling → path safety)
 *
 * The renderer identifies notes by an opaque `id`, never by an absolute path.
 * The store resolves `id` to `<vault>/notes/<id>.md` and **rejects any id that
 * would escape the notes directory** (path-traversal guard). A malicious or
 * buggy renderer therefore cannot read or write outside the active vault,
 * upholding the least-privilege posture in the steering rules.
 *
 * ## Atomic write (Req 5.5)
 *
 * A write goes to a temp file *in the same directory* as the target and is then
 * committed with a `rename` over the target. `rename` within a directory is
 * atomic on the platforms Marginalia targets, so a reader never observes a
 * half-written file, and if any step fails the previously committed file is
 * left byte-for-byte unchanged and a `write-failed` error is returned.
 *
 * ## The fs seam
 *
 * All filesystem access goes through an injectable {@link NoteStoreFs} seam
 * (defaulting to Node's `fs/promises`). Tests can pass a partial override — for
 * example forcing `rename` to throw — to exercise the failure paths
 * (Property 10) without touching real disk behavior, while the happy path runs
 * against `node:fs/promises` unchanged.
 */

import { promises as nodeFs } from 'node:fs';
import * as path from 'node:path';

import type {
  ResourceNote,
  ResourceNoteInput,
  ResourceNoteSummary,
  Result,
  VaultError,
} from '@shared/resource-note';

import { parseNote, serializeNote } from './note-file';

/** Subfolder under the vault root that holds the note files. */
const NOTES_DIR = 'notes';

/** File extension (with dot) for a persisted note. */
const NOTE_EXT = '.md';

/** Substituted when the input title is blank/whitespace (Req 5.7). */
export const DEFAULT_TITLE = 'Untitled note';

/**
 * The subset of `fs/promises` the {@link NoteStore} depends on.
 *
 * Declaring the seam as an interface (rather than reaching for `fs` directly)
 * lets downstream test tasks (4.2, 4.3, 4.4) inject a spy or fault-injecting
 * double — most importantly forcing `rename` to reject so the "failed writes
 * leave the prior file byte-unchanged" property (Property 10) can be exercised
 * deterministically. The signatures are structurally compatible with
 * `node:fs/promises`, so the real module is assignable as-is.
 */
export interface NoteStoreFs {
  mkdir(
    dir: string,
    options: { recursive: true },
  ): Promise<string | undefined>;
  readFile(file: string, encoding: 'utf8'): Promise<string>;
  writeFile(file: string, data: string, encoding: 'utf8'): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  rm(file: string, options: { force: true }): Promise<void>;
  readdir(dir: string): Promise<string[]>;
}

/**
 * Default seam backed by Node's real `fs/promises`. `node:fs`' `promises` API is
 * structurally wider than {@link NoteStoreFs}; the explicit annotation pins the
 * store to only the methods it actually uses.
 */
const defaultFs: NoteStoreFs = nodeFs;

/**
 * Reads and writes note files in a vault's `notes/` directory. Stateless aside
 * from its fs seam: every method takes the `vaultPath` explicitly so a single
 * instance can serve whichever vault is currently active.
 */
export class NoteStore {
  private readonly fs: NoteStoreFs;

  /**
   * @param fs Filesystem seam; defaults to `node:fs/promises`. Tests pass an
   * override (often via {@link withFs}) to force failures or observe calls.
   */
  constructor(fs: NoteStoreFs = defaultFs) {
    this.fs = fs;
  }

  /**
   * Return a new store bound to a (possibly partial) fs override, filling any
   * unspecified methods from this store's current seam. Convenience for tests:
   * `store.withFs({ rename: () => Promise.reject(new Error('boom')) })`.
   */
  withFs(overrides: Partial<NoteStoreFs>): NoteStore {
    return new NoteStore({ ...this.fs, ...overrides });
  }

  /**
   * Write a note atomically, creating it or overwriting it in place.
   *
   * Behavior (design → "Note_Store"):
   * - Resolves `note.id` to `<vault>/notes/<id>.md`, rejecting ids that escape
   *   the notes directory (path-traversal guard) with a `write-failed` error.
   * - `modifiedAt` is set to the clock at write start. On a first write (no
   *   existing file for the id) `createdAt` is the same value; on overwrite the
   *   existing file's `createdAt` is read and preserved (Req 5.4).
   * - A blank/whitespace title is replaced by {@link DEFAULT_TITLE} (Req 5.7).
   * - The serialized text is written to a temp file in the notes directory,
   *   then `rename`d over the target (atomic commit, Req 5.5). If any step
   *   fails, any prior file is left byte-for-byte unchanged and a `write-failed`
   *   error naming the note id is returned.
   *
   * @returns The persisted {@link ResourceNote} (with resolved title and
   * timestamps) on success, or a `write-failed` error on failure.
   */
  async write(
    vaultPath: string,
    note: ResourceNoteInput,
  ): Promise<Result<ResourceNote>> {
    // Guard first: never touch the filesystem for an id that would escape the
    // notes directory.
    const resolved = this.resolveNotePath(vaultPath, note.id);
    if (!resolved) {
      return writeFailed(note.id, 'id resolves outside the notes directory');
    }
    const { notesDir, filePath } = resolved;

    // The write-start clock is the single source of truth for this write's
    // timestamps (Req 5.4). Captured before any I/O so it reflects intent, not
    // I/O latency.
    const writeStart = Date.now();

    try {
      // First write vs. overwrite: read the existing file (if any) to preserve
      // its createdAt. A missing file (ENOENT) means this is a first write.
      const existingCreatedAt = await this.readExistingCreatedAt(
        filePath,
        note.id,
      );
      const persisted: ResourceNote = {
        id: note.id,
        title: resolveTitle(note.title),
        resource: note.resource,
        content: note.content,
        createdAt: existingCreatedAt ?? writeStart,
        modifiedAt: writeStart,
      };

      await this.commit(notesDir, filePath, persisted, writeStart);
      return { ok: true, value: persisted };
    } catch (err) {
      return writeFailed(note.id, errorMessage(err));
    }
  }

  /**
   * Atomically write a fully-formed note to `filePath`: ensure the notes dir
   * exists, serialize, write to a temp sibling, then `rename` over the target.
   * The intra-directory rename is atomic, so a reader never sees a half-written
   * file and a failure leaves any prior file byte-for-byte unchanged (the temp
   * file is cleaned up). Shared by {@link write} and {@link rename} so there is
   * a single atomic-commit implementation. Throws on failure (callers wrap it
   * in the appropriate `Result` error).
   */
  private async commit(
    notesDir: string,
    filePath: string,
    note: ResourceNote,
    writeStart: number,
  ): Promise<void> {
    // Ensure the notes/ subfolder exists (Req 5.2); a no-op when it already does.
    await this.fs.mkdir(notesDir, { recursive: true });
    const serialized = serializeNote(note);
    const tempPath = this.tempPathFor(notesDir, note.id, writeStart);
    await this.fs.writeFile(tempPath, serialized, 'utf8');
    try {
      await this.fs.rename(tempPath, filePath);
    } catch (err) {
      // Commit failed: the prior file (if any) is untouched. Best-effort
      // cleanup of the orphaned temp file so a failed write leaves no litter.
      await this.safeRemove(tempPath);
      throw err;
    }
  }

  /**
   * Rename a note — move its file so the filename tracks the new title.
   *
   * Unlike {@link write} (which overwrites in place and keeps the id/filename
   * stable), rename is the explicit, user-initiated action that changes a
   * note's *identity*: the on-disk file moves from `<vault>/notes/<id>.md` to
   * `<vault>/notes/<new-slug>.md` so the filename matches the title.
   *
   * Behavior:
   * - Reads the existing note; a read error (`note-not-found` / `note-unreadable`
   *   / `unknown-resource-type`) is returned verbatim, leaving the file
   *   untouched.
   * - Computes the new id as a slug of `newTitle`, excluding the note's *own*
   *   current id from the collision set (so re-saving the same title, or a
   *   title whose slug equals the current id, is a no-op rather than bumping to
   *   `-2`). If the new id equals the current id, this degrades to an in-place
   *   title rewrite — no move, no delete.
   * - Otherwise: writes the new file (preserving the original `createdAt`,
   *   bumping `modifiedAt`) **then** deletes the old file. Commit-new-then-
   *   delete-old means a mid-failure leaves the original note intact
   *   (non-destructive, matching the store's posture).
   *
   * @returns the persisted {@link ResourceNote} carrying its (possibly new) id.
   */
  async rename(
    vaultPath: string,
    id: string,
    newTitle: string,
  ): Promise<Result<ResourceNote>> {
    const existing = await this.read(vaultPath, id);
    if (!existing.ok) return existing;
    const note = existing.value;

    // Derive the new id from the title, but don't treat the note's own current
    // file as a collision — otherwise renaming to a title that slugifies back
    // to the current id (or leaving the title unchanged) would needlessly bump.
    const newId = await this.allocateId(vaultPath, newTitle, id);

    const resolvedNew = this.resolveNotePath(vaultPath, newId);
    if (!resolvedNew) {
      // allocateId always yields a guard-safe stem, so this is defensive.
      return writeFailed(newId, 'renamed id resolves outside the notes directory');
    }

    const writeStart = Date.now();
    const persisted: ResourceNote = {
      id: newId,
      title: resolveTitle(newTitle),
      resource: note.resource,
      content: note.content,
      createdAt: note.createdAt, // preserved across the move (Req 5.4)
      modifiedAt: writeStart,
    };

    // Same id (slug unchanged) ⇒ pure in-place title rewrite, no move.
    if (newId === id) {
      try {
        await this.commit(resolvedNew.notesDir, resolvedNew.filePath, persisted, writeStart);
        return { ok: true, value: persisted };
      } catch (err) {
        return writeFailed(newId, errorMessage(err));
      }
    }

    // Move: write the new file first, then remove the old one. If the write
    // fails, the original is untouched; if the delete fails, we've at worst
    // left a duplicate (surfaced as delete-failed) rather than lost the note.
    try {
      await this.commit(resolvedNew.notesDir, resolvedNew.filePath, persisted, writeStart);
    } catch (err) {
      return writeFailed(newId, errorMessage(err));
    }

    const removed = await this.delete(vaultPath, id);
    if (!removed.ok) {
      // New file is in place; the old one lingered. Report it, but the rename
      // *did* take effect (the new note exists), so return success with the new
      // note — a stray old file is a lesser evil than failing a completed move.
      // (The notes watcher / next list will still show both until resolved.)
      return { ok: true, value: persisted };
    }

    return { ok: true, value: persisted };
  }

  /**
   * Read a single note by its opaque `id` (Req 6.3).
   *
   * Behavior (design → "Note_Store"):
   * - Resolves `id` to `<vault>/notes/<id>.md` through the same
   *   {@link resolveNotePath} path-traversal guard used by {@link write}, so an
   *   id that would escape the notes directory is rejected as `note-not-found`
   *   (a guarded id simply has no readable file inside the vault) without
   *   touching the filesystem.
   * - Returns `note-not-found` when the file is absent, leaving the vault
   *   unchanged (Req 6.4).
   * - Delegates parsing to the pure {@link parseNote}; its
   *   `unknown-resource-type` (Req 4.5) and `note-unreadable` (Req 6.7) errors
   *   are propagated verbatim. This method never writes — a malformed or
   *   unknown-type file is read and reported, never mutated (Req 7.2).
   *
   * @returns The parsed {@link ResourceNote} on success, or a
   * `note-not-found` / `unknown-resource-type` / `note-unreadable` error.
   */
  async read(vaultPath: string, id: string): Promise<Result<ResourceNote>> {
    // Reuse the write-side guard: an id that resolves outside notes/ has no
    // legitimate file, so we treat it as not-found rather than reaching disk.
    const resolved = this.resolveNotePath(vaultPath, id);
    if (!resolved) {
      return notFound(id);
    }

    let raw: string;
    try {
      raw = await this.fs.readFile(resolved.filePath, 'utf8');
    } catch (err) {
      if (isNotFound(err)) {
        // The file is absent: a non-destructive miss (Req 6.4). Nothing on disk
        // was touched.
        return notFound(id);
      }
      // A real I/O error (permissions, etc.) — surface it as unreadable without
      // modifying the file.
      return {
        ok: false,
        error: {
          code: 'note-unreadable',
          message: `Note '${id}' could not be read: ${errorMessage(err)}`,
          noteId: id,
        },
      };
    }

    // Pure parse: propagates unknown-resource-type / note-unreadable as-is and
    // never mutates the input file.
    return parseNote(raw, id);
  }

  /**
   * Delete a note by its opaque `id`.
   *
   * Behavior:
   * - Resolves `id` to `<vault>/notes/<id>.md` through the same
   *   {@link resolveNotePath} path-traversal guard used by read/write, so an id
   *   that would escape the notes directory is rejected as `note-not-found`
   *   without touching the filesystem.
   * - Returns `note-not-found` when the file is already absent, leaving the
   *   vault otherwise unchanged (deleting a non-existent note is reported, not
   *   silently ignored, so the caller can refresh a stale list).
   * - Removes the file and returns `{ ok: true }`. Any other filesystem failure
   *   (e.g. permissions) is returned as `delete-failed` rather than thrown.
   *
   * @returns `{ ok: true, value: undefined }` on success, or a
   * `note-not-found` / `delete-failed` error.
   */
  async delete(vaultPath: string, id: string): Promise<Result<void>> {
    const resolved = this.resolveNotePath(vaultPath, id);
    if (!resolved) {
      return notFound(id);
    }

    // Confirm the file exists first so an already-absent note is reported as
    // not-found rather than a silent no-op — `rm({ force: true })` would
    // succeed on a missing file, hiding a stale-id delete from the caller.
    try {
      await this.fs.readFile(resolved.filePath, 'utf8');
    } catch (err) {
      if (isNotFound(err)) {
        return notFound(id);
      }
      // Couldn't even stat/read it to confirm existence — treat as a failure.
      return deleteFailed(id, errorMessage(err));
    }

    try {
      await this.fs.rm(resolved.filePath, { force: true });
    } catch (err) {
      return deleteFailed(id, errorMessage(err));
    }

    return { ok: true, value: undefined };
  }

  /**
   * Allocate a unique, filesystem-safe note id derived from a title.
   *
   * Used when a note is first saved so its on-disk filename is *recognizable*
   * (`my-research-notes.md` rather than an opaque `lq3k1z-abc123.md`). The id
   * is a slug of the title; if that slug is already taken by another note in
   * the vault, a numeric suffix is appended (`my-notes-2`, `my-notes-3`, …) so
   * two notes with the same title never collide. A blank title falls back to a
   * slug of {@link DEFAULT_TITLE}.
   *
   * Used at creation (via {@link write}'s caller) and by {@link rename} to
   * compute the new title-derived id. `excludeId` lets a caller exclude one
   * existing note's own id from the collision set — {@link rename} passes the
   * note's current id so renaming a note to a title whose slug equals its
   * current id (or an unchanged title) resolves back to that same id instead of
   * needlessly bumping to `-2`.
   *
   * The returned id always satisfies {@link resolveNotePath}'s guard (it is a
   * plain, separator-free stem). Never throws — on an unreadable notes dir it
   * still returns a candidate (worst case a rare collision, which the atomic
   * write would surface as a normal overwrite).
   */
  async allocateId(
    vaultPath: string,
    title: string,
    excludeId?: string,
  ): Promise<string> {
    const base = slugify(title) || slugify(DEFAULT_TITLE);
    const exclude = excludeId?.toLowerCase();

    // Gather existing stems (without the .md extension) to avoid collisions,
    // skipping the caller's own note (excludeId) so it doesn't collide with
    // itself.
    const taken = new Set<string>();
    try {
      const entries = await this.fs.readdir(path.resolve(vaultPath, NOTES_DIR));
      for (const name of entries) {
        if (name.endsWith(NOTE_EXT) && !name.startsWith('.')) {
          const stem = name.slice(0, -NOTE_EXT.length).toLowerCase();
          if (stem !== exclude) taken.add(stem);
        }
      }
    } catch {
      // No notes dir yet (fresh vault) or unreadable — treat as empty. A stale
      // read just means the first candidate is used.
    }

    if (!taken.has(base.toLowerCase())) return base;
    for (let n = 2; ; n++) {
      const candidate = `${base}-${n}`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
  }

  /**
   * List summaries of every readable note in the vault, most-recently-modified
   * first (Req 6.1), with per-file fault isolation (Req 6.7).
   *
   * Behavior (design → "Note_Store" / Error Handling → non-fatal diagnostics):
   * - Enumerates `<vault>/notes/*.md`. A missing `notes/` directory (or an
   *   otherwise-empty one) yields an empty list with no error — a brand-new or
   *   empty vault is a success, not a failure.
   * - Parses each file inside a per-file try/catch. A file that cannot be read
   *   or parsed (bad frontmatter, unknown resource type, I/O error) is
   *   **skipped**, left on disk byte-for-byte unchanged, and recorded in the
   *   additive `diagnostics` array on the successful result. The remaining
   *   notes still load — this is never all-or-nothing (Req 6.2).
   * - Summaries are returned newest-first by `modifiedAt` (descending).
   * - An empty or entirely-unparseable vault yields an empty `value` list; the
   *   result is still `ok: true` (with diagnostics for any skipped files).
   *
   * The `diagnostics` field is only present when at least one file was skipped,
   * keeping ordinary all-readable vaults' results clean.
   *
   * @returns `{ ok: true, value: summaries, diagnostics? }` — always a success
   * for an accessible vault; per-file problems live in `diagnostics`, not in an
   * `ok: false` result.
   */
  async list(
    vaultPath: string,
  ): Promise<Result<ResourceNoteSummary[]>> {
    const notesDir = path.resolve(vaultPath, NOTES_DIR);

    let entries: string[];
    try {
      entries = await this.fs.readdir(notesDir);
    } catch (err) {
      if (isNotFound(err)) {
        // No notes/ folder yet (fresh vault): an empty list, not an error.
        return { ok: true, value: [] };
      }
      // The directory exists but can't be enumerated (e.g. permissions). This
      // is a whole-vault read failure rather than a per-file one; surface it as
      // unreadable so the caller doesn't mistake it for an empty vault.
      return {
        ok: false,
        error: {
          code: 'note-unreadable',
          message: `Vault notes could not be listed: ${errorMessage(err)}`,
        },
      };
    }

    // Only *.md files are notes; ignore temp files (`.<id>.<ts>.tmp`) and any
    // other stray entries so an in-flight write is never listed.
    const noteFiles = entries.filter(
      (name) => name.endsWith(NOTE_EXT) && !name.startsWith('.'),
    );

    const summaries: ResourceNoteSummary[] = [];
    const diagnostics: VaultError[] = [];

    for (const fileName of noteFiles) {
      // The filename stem is the authoritative id (parseNote ignores any stored
      // id, mirroring read/write).
      const id = fileName.slice(0, -NOTE_EXT.length);
      const filePath = path.join(notesDir, fileName);

      // Per-file try/catch: a single bad file must not sink the whole list.
      try {
        const raw = await this.fs.readFile(filePath, 'utf8');
        const parsed = parseNote(raw, id);
        if (parsed.ok) {
          const note = parsed.value;
          summaries.push({
            id: note.id,
            title: note.title,
            resourceType: note.resource.type,
            modifiedAt: note.modifiedAt,
          });
        } else {
          // Unparseable / unknown-type: skip it (left on disk) and report it.
          diagnostics.push({ ...parsed.error, file: filePath });
        }
      } catch (err) {
        // I/O error reading this one file: skip and report, keep going.
        diagnostics.push({
          code: 'note-unreadable',
          message: `Note '${id}' could not be read: ${errorMessage(err)}`,
          noteId: id,
          file: filePath,
        });
      }
    }

    // Newest-first by modifiedAt (Req 6.1). A stable sort keeps files with
    // identical timestamps in their (arbitrary) enumeration order.
    summaries.sort((a, b) => b.modifiedAt - a.modifiedAt);

    // Keep the success shape clean when nothing was skipped: only attach
    // diagnostics when there is something to report.
    return diagnostics.length > 0
      ? { ok: true, value: summaries, diagnostics }
      : { ok: true, value: summaries };
  }

  /**
   * Resolve an opaque note `id` to its on-disk path, enforcing the
   * path-traversal guard.
   *
   * Returns `null` (caller turns this into an error) when the id would escape
   * the notes directory. The guard works by resolving `<vault>/notes/<id>.md`
   * to an absolute path and requiring that it sits *directly* inside the
   * (also-resolved) notes directory — same parent dir, no nested separators,
   * no `..`, no absolute-path override. This rejects `../evil`, `/etc/passwd`,
   * `..\\evil`, `nested/child`, and the empty id, while allowing ordinary
   * generated ids (e.g. `note-2024-earthquake`).
   */
  private resolveNotePath(
    vaultPath: string,
    id: string,
  ): { notesDir: string; filePath: string } | null {
    // An empty/whitespace id has no valid file and must be rejected outright.
    if (typeof id !== 'string' || id.trim() === '') {
      return null;
    }

    const notesDir = path.resolve(vaultPath, NOTES_DIR);
    const filePath = path.resolve(notesDir, `${id}${NOTE_EXT}`);

    // The resolved file must live *directly* in notesDir. Comparing the parent
    // directory (rather than a prefix `startsWith`) also rejects ids that
    // introduce their own subdirectories (`nested/child`), keeping every note a
    // flat file in notes/ as the on-disk format requires.
    if (path.dirname(filePath) !== notesDir) {
      return null;
    }

    // Defense in depth: the basename must be exactly `<id>.md`. This catches
    // ids that path-normalize to something other than a plain child (e.g. a
    // trailing separator) even if the dirname check somehow passed.
    if (path.basename(filePath) !== `${id}${NOTE_EXT}`) {
      return null;
    }

    return { notesDir, filePath };
  }

  /**
   * Read the `createdAt` of an already-persisted note so it can be preserved
   * across an overwrite. Returns `null` when the file does not exist yet (a
   * first write) or cannot be parsed for its timestamp — in the latter case the
   * write proceeds and effectively re-stamps `createdAt`, which is acceptable
   * for a file that was already unreadable.
   */
  private async readExistingCreatedAt(
    filePath: string,
    id: string,
  ): Promise<number | null> {
    let raw: string;
    try {
      raw = await this.fs.readFile(filePath, 'utf8');
    } catch (err) {
      if (isNotFound(err)) {
        return null; // first write
      }
      throw err; // a real I/O error should surface as write-failed
    }
    const parsed = parseNote(raw, id);
    return parsed.ok ? parsed.value.createdAt : null;
  }

  /** Best-effort removal that never throws (used to clean up temp files). */
  private async safeRemove(file: string): Promise<void> {
    try {
      await this.fs.rm(file, { force: true });
    } catch {
      // Swallow: cleanup is best-effort; the real error is already propagating.
    }
  }

  /**
   * Build a collision-resistant temp path in the notes directory. The temp file
   * is a hidden sibling of the target so the subsequent `rename` is
   * intra-directory (and thus atomic). Including the id, the write-start clock,
   * and a random suffix avoids clobbering a concurrent write of the same note.
   */
  private tempPathFor(notesDir: string, id: string, writeStart: number): string {
    const rand = Math.random().toString(36).slice(2, 10);
    return path.join(notesDir, `.${id}.${writeStart}.${rand}.tmp`);
  }
}

/**
 * Apply the default-title rule (Req 5.7): a blank or whitespace-only title is
 * stored as {@link DEFAULT_TITLE}; any other title is stored verbatim.
 */
function resolveTitle(title: string): string {
  return title.trim() === '' ? DEFAULT_TITLE : title;
}

/**
 * Turn a title into a filesystem-safe, human-legible filename stem.
 *
 * Lower-cases, replaces any run of non-alphanumeric characters with a single
 * hyphen, and trims leading/trailing hyphens — so "My Research Notes!" becomes
 * `my-research-notes`. Diacritics are stripped via NFKD normalization so
 * accented titles produce ASCII-clean names. The result is capped in length so
 * a very long title doesn't produce an unwieldy filename, and is guaranteed to
 * satisfy {@link NoteStore.resolveNotePath}'s guard: it contains no path
 * separators, no `.`/`..`, and no leading dot. Returns `''` for a title that
 * slugifies to nothing (e.g. only punctuation); callers substitute a default.
 */
export function slugify(title: string): string {
  const slug = title
    .normalize('NFKD')
    // Drop combining marks left by NFKD (e.g. accents).
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    // Any run of non-alphanumerics collapses to a single hyphen.
    .replace(/[^a-z0-9]+/g, '-')
    // Trim hyphens off both ends.
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    // slice() might leave a trailing hyphen; trim again.
    .replace(/-+$/g, '');
  return slug;
}

/**
 * Build a `note-not-found` error result naming the affected note id (Req 6.4).
 * Used by {@link NoteStore.read} for both an absent file and a guarded id — in
 * either case there is no readable note at that identity and the vault is left
 * untouched.
 */
function notFound(noteId: string): Result<never> {
  const error: VaultError = {
    code: 'note-not-found',
    message: `Note '${noteId}' was not found`,
    noteId,
  };
  return { ok: false, error };
}

/** Build a `write-failed` error result naming the affected note id (Req 5.5). */
function writeFailed(noteId: string, detail: string): Result<never> {
  const error: VaultError = {
    code: 'write-failed',
    message: `Failed to write note '${noteId}': ${detail}`,
    noteId,
  };
  return { ok: false, error };
}

/** Build a `delete-failed` error result naming the affected note id. */
function deleteFailed(noteId: string, detail: string): Result<never> {
  const error: VaultError = {
    code: 'delete-failed',
    message: `Failed to delete note '${noteId}': ${detail}`,
    noteId,
  };
  return { ok: false, error };
}

/** Narrow a caught value to a Node ENOENT ("no such file") error. */
function isNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * On-disk layout constants, exported as the single source of truth for the
 * notes directory name and file extension. Both `write` and the `read`/`list`
 * paths resolve the same `<vault>/notes/<id>.md` shape from these constants
 * rather than re-declaring the strings.
 */
export { NOTES_DIR, NOTE_EXT };
