// Feature: vault-and-notes, Property 11: Designate-then-recognize round-trip
// Feature: vault-and-notes, Property 12: Opening a valid vault sets it as the sole active vault
// Feature: vault-and-notes, Property 13: Opening an invalid vault folder errors without changing state

/**
 * Property-based tests for the Vault_Manager's marker recognition, folder
 * designation, and open semantics, exercised over *real* temp directories
 * under `os.tmpdir()` (design → Testing Strategy: the recognition/marker layer
 * is UI-free precisely so it can be property-tested against the filesystem
 * without an Electron window).
 *
 * Three laws are under test:
 *
 *   Property 11 (Designate-then-recognize round-trip, Req 1.2/1.3): for any
 *   writable folder, `designateVault(dir)` succeeds and a subsequent
 *   `recognizeVault(dir)` reports `'vault'` (equivalently `isVault(dir)` is
 *   `true`). Designating a folder is exactly what makes it recognizable.
 *
 *   Property 12 (Opening a valid vault sets it as the sole active vault,
 *   Req 2.2/2.6): opening a folder that *is* a valid vault succeeds and leaves
 *   that vault as the one and only active vault, regardless of what was active
 *   before (there is never more than one active vault).
 *
 *   Property 13 (Opening an invalid vault folder errors without changing state,
 *   Req 2.3/2.4): opening a folder with no marker fails with `not-a-vault` and
 *   opening one with a malformed marker fails with `vault-unreadable`; in both
 *   cases the previously-active vault is left unchanged.
 *
 * ── Note on task sequencing ──────────────────────────────────────────────────
 * Task 5.1 shipped the pure primitives this file drives directly:
 * `designateVault`, `recognizeVault`, `isVault`, and the marker constants. The
 * full `VaultManager` class with `open()`/`getActive()` (task 5.3) is landing
 * concurrently and is NOT yet present in `vault-manager.ts` at the time this
 * test was written. Per the task guidance, Properties 12 and 13 are therefore
 * expressed against `recognizeVault` (the pure core of `open()`), asserting the
 * recognition classification that `open()` maps onto its active-vault state and
 * `VaultError` codes:
 *
 *   recognizeVault → 'vault'       ⇒ open() sets it active (Property 12)
 *   recognizeVault → 'not-a-vault' ⇒ open() returns `not-a-vault`  (Property 13)
 *   recognizeVault → 'unreadable'  ⇒ open() returns `vault-unreadable` (Property 13)
 *
 * The "sole active vault" and "leaves active unchanged" halves are modeled with
 * a tiny in-test active-vault holder that follows those exact rules, so the
 * *semantics* are asserted even before `VaultManager.open()` exists. When 5.3
 * lands, these can be re-pointed at the real `VaultManager.open()` with an
 * injected dialog seam returning the chosen folder; the recognition-level
 * assertions here remain valid as the substrate.
 *
 * Validates: Requirements 1.2, 1.3, 2.2, 2.3, 2.4
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// Namespace import: fast-check re-exports helpers as named exports *and* a
// default namespace, so `import fc from 'fast-check'` + `fc.string()` trips
// eslint-plugin-import's no-named-as-default-member rule. `* as` keeps the
// conventional `fc.` call sites warning-free (matching note-file.test.ts).
import * as fc from 'fast-check';

import type { VaultError, VaultInfo } from '@shared/resource-note';

import {
  MARKER_DIR,
  MARKER_FILE,
  designateVault,
  isVault,
  recognizeVault,
} from '@main/vault/vault-manager';

/**
 * A scratch directory under the OS temp dir that every test in this file works
 * inside. Created fresh before each test and removed after, so the property
 * runs (each of which mkdir's many sub-folders) never collide or leak.
 */
let scratch: string;

beforeEach(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'marginalia-vault-'));
});

afterEach(async () => {
  await fs.rm(scratch, { recursive: true, force: true });
});

/** Create a fresh, empty, writable sub-folder inside the scratch dir. */
async function makeFolder(name: string): Promise<string> {
  const dir = path.join(scratch, name);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** Absolute path to a folder's marker file. */
function markerPath(dir: string): string {
  return path.join(dir, MARKER_DIR, MARKER_FILE);
}

/** Overwrite a folder's marker file with arbitrary (malformed) bytes. */
async function writeMalformedMarker(dir: string, contents: string): Promise<void> {
  await fs.mkdir(path.join(dir, MARKER_DIR), { recursive: true });
  await fs.writeFile(markerPath(dir), contents, 'utf8');
}

/** A `VaultInfo` for a folder, matching what `open()` would set active. */
function vaultInfoFor(dir: string): VaultInfo {
  return { path: dir, name: path.basename(dir) };
}

/**
 * Model of the active-vault slot that `VaultManager.open()` (task 5.3) owns.
 * It encodes the exact open semantics under test so Properties 12/13 assert the
 * *behavior* against the real `recognizeVault` even before the class exists:
 *
 *   - a `'vault'` recognition replaces whatever was active (sole active), and
 *   - a `'not-a-vault'`/`'unreadable'` recognition returns the mapped error and
 *     leaves the active vault untouched.
 *
 * When task 5.3 lands, replace calls to `openInto` with `manager.open()` using
 * an injected dialog seam that returns `dir`; the assertions stay the same.
 */
async function openInto(
  active: { current: VaultInfo | null },
  dir: string,
): Promise<{ ok: true; value: VaultInfo } | { ok: false; error: VaultError }> {
  const recognition = await recognizeVault(dir);
  switch (recognition) {
    case 'vault': {
      const info = vaultInfoFor(dir);
      active.current = info; // replaces any prior active vault (Req 2.2)
      return { ok: true, value: info };
    }
    case 'not-a-vault':
      return {
        ok: false,
        error: { code: 'not-a-vault', message: `'${dir}' is not a vault` },
      };
    case 'unreadable':
      return {
        ok: false,
        error: { code: 'vault-unreadable', message: `'${dir}' vault marker is unreadable` },
      };
  }
}

describe('vault-manager designate/recognize (Property 11)', () => {
  it('designating a writable folder then recognizing it succeeds', async () => {
    await fc.assert(
      fc.asyncProperty(
        // A per-run folder name (safe, collision-free stems within the scratch).
        fc.uuid(),
        async (name) => {
          const dir = await makeFolder(`p11-${name}`);

          // Before designation, an ordinary folder is not a vault.
          expect(await recognizeVault(dir)).toBe('not-a-vault');

          // Designate: writes the marker, returns ok.
          const result = await designateVault(dir);
          expect(result.ok).toBe(true);

          // After designation, recognition reports a vault …
          expect(await recognizeVault(dir)).toBe('vault');
          // … and the boolean convenience agrees.
          expect(await isVault(dir)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('designation is idempotent — re-designating keeps the folder a vault', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uuid(), async (name) => {
        const dir = await makeFolder(`p11-idem-${name}`);

        expect((await designateVault(dir)).ok).toBe(true);
        expect((await designateVault(dir)).ok).toBe(true);
        expect(await recognizeVault(dir)).toBe('vault');
      }),
      { numRuns: 100 },
    );
  });
});

describe('vault-manager open of a valid vault (Property 12)', () => {
  it('opening a valid vault sets it active and leaves at most one active, regardless of prior state', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(),
        // Prior active state: either nothing active, or some other vault active.
        fc.option(fc.uuid(), { nil: null }),
        async (name, priorName) => {
          // The folder to open — a genuine, freshly-designated vault.
          const toOpen = await makeFolder(`p12-open-${name}`);
          expect((await designateVault(toOpen)).ok).toBe(true);

          // Seed the prior active vault (a *different* valid vault) when asked.
          const active: { current: VaultInfo | null } = { current: null };
          if (priorName !== null) {
            const prior = await makeFolder(`p12-prior-${priorName}`);
            expect((await designateVault(prior)).ok).toBe(true);
            active.current = vaultInfoFor(prior);
          }

          const result = await openInto(active, toOpen);

          // Opening a valid vault succeeds …
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          // … the opened folder becomes the active vault …
          expect(active.current).toEqual(vaultInfoFor(toOpen));
          expect(result.value).toEqual(vaultInfoFor(toOpen));
          // … and there is exactly one active vault (the slot holds a single
          // VaultInfo, never a set) pointing at the just-opened folder — any
          // prior active vault has been replaced (Req 2.2).
          expect(active.current?.path).toBe(toOpen);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('vault-manager open of an invalid folder (Property 13)', () => {
  it('opening a marker-less folder returns not-a-vault and leaves the active vault unchanged', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(),
        // Prior active state to prove it is left untouched on failure.
        fc.option(fc.uuid(), { nil: null }),
        async (name, priorName) => {
          // A plain folder with no marker at all.
          const plain = await makeFolder(`p13-plain-${name}`);

          const active: { current: VaultInfo | null } = { current: null };
          let priorInfo: VaultInfo | null = null;
          if (priorName !== null) {
            const prior = await makeFolder(`p13-prior-${priorName}`);
            expect((await designateVault(prior)).ok).toBe(true);
            priorInfo = vaultInfoFor(prior);
            active.current = priorInfo;
          }

          // recognizeVault classifies a marker-less folder as not-a-vault …
          expect(await recognizeVault(plain)).toBe('not-a-vault');

          const result = await openInto(active, plain);

          // … open fails with the mapped `not-a-vault` code …
          expect(result.ok).toBe(false);
          if (result.ok) return;
          expect(result.error.code).toBe('not-a-vault');
          // … and the active vault is exactly what it was before (Req 2.3).
          expect(active.current).toEqual(priorInfo);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('opening a folder with a malformed marker returns vault-unreadable and leaves the active vault unchanged', async () => {
    // A corpus of markers that exist but are not a valid, readable vault marker:
    // non-JSON bytes, JSON that is not an object, and objects lacking the
    // `marginaliaVault: true` signal — every shape recognizeVault must classify
    // as `unreadable` (mapped to the `vault-unreadable` error by open()).
    const malformedMarkerArb = fc.oneof(
      fc.constant('not json at all {{{'),
      fc.constant(''),
      fc.constant('[]'),
      fc.constant('42'),
      fc.constant('"a string"'),
      fc.constant('null'),
      fc.constant('{"marginaliaVault": false}'),
      fc.constant('{"marginaliaVault": "true"}'),
      fc.constant('{"version": 1}'),
      fc.constant('{}'),
    );

    await fc.assert(
      fc.asyncProperty(
        fc.uuid(),
        malformedMarkerArb,
        fc.option(fc.uuid(), { nil: null }),
        async (name, markerContents, priorName) => {
          const broken = await makeFolder(`p13-broken-${name}`);
          await writeMalformedMarker(broken, markerContents);

          const active: { current: VaultInfo | null } = { current: null };
          let priorInfo: VaultInfo | null = null;
          if (priorName !== null) {
            const prior = await makeFolder(`p13-broken-prior-${priorName}`);
            expect((await designateVault(prior)).ok).toBe(true);
            priorInfo = vaultInfoFor(prior);
            active.current = priorInfo;
          }

          // A present-but-broken marker is classified `unreadable` …
          expect(await recognizeVault(broken)).toBe('unreadable');

          const result = await openInto(active, broken);

          // … open fails with the mapped `vault-unreadable` code …
          expect(result.ok).toBe(false);
          if (result.ok) return;
          expect(result.error.code).toBe('vault-unreadable');
          // … and the active vault is left unchanged (Req 2.4).
          expect(active.current).toEqual(priorInfo);
        },
      ),
      { numRuns: 100 },
    );
  });
});
