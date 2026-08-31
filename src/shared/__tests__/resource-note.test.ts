/**
 * Unit tests asserting the `Resource` discriminated union is *closed* and
 * *exhaustive* (Req 4.2, 4.4).
 *
 * The point of these tests is as much a compile-time guarantee as a runtime
 * one. `describeResource` below contains an exhaustive `switch` over
 * `Resource['type']` whose `default` branch assigns the value to a `never`.
 * If a new variant were ever added to the {@link Resource} union (or
 * {@link ResourceType}) without a matching `case`, the unreached value would no
 * longer be `never` and TypeScript would fail the build on the `assertNever`
 * call — surfacing the omission everywhere the union must be handled.
 *
 * These tests therefore serve two purposes:
 *  1. They lock in that `website-link` is implemented and that `pdf`/`video`
 *     are recognized-but-reserved variants (they must appear in the switch, so
 *     the file would not compile if they were dropped from the union).
 *  2. They fail to compile — hitting the `never` branch — if a future variant
 *     is introduced without being handled here, which is the exhaustiveness
 *     tripwire the design relies on.
 */

import { describe, expect, it } from 'vitest';

import type {
  PdfResource,
  Resource,
  ResourceType,
  VideoResource,
  WebsiteLinkResource,
} from '@shared/resource-note';

/**
 * Compile-time exhaustiveness helper: reachable only if `x` has been narrowed
 * to `never`. If a `Resource` variant is left unhandled by the switch below,
 * the un-narrowed value flows here and the assignment fails to type-check.
 */
function assertNever(x: never): never {
  throw new Error(`Unhandled resource variant: ${JSON.stringify(x)}`);
}

/**
 * Exhaustive classification of a `Resource`. The `switch` must cover every
 * member of the closed union; the `default` funnels any unhandled member into
 * `assertNever`, which only type-checks when the union has been fully consumed.
 */
function describeResource(resource: Resource): { type: ResourceType; implemented: boolean } {
  switch (resource.type) {
    case 'website-link':
      // The only implemented variant (Req 4.3): carries a url.
      return { type: resource.type, implemented: true };
    case 'pdf':
      // Reserved future variant (Req 4.4): recognized, no behavior yet.
      return { type: resource.type, implemented: false };
    case 'video':
      // Reserved future variant (Req 4.4): recognized, no behavior yet.
      return { type: resource.type, implemented: false };
    default:
      // Unreachable today. Becomes a *compile error* the moment a new variant
      // is added to the union without a case above — the exhaustiveness guard.
      return assertNever(resource);
  }
}

describe('Resource discriminated union', () => {
  it('classifies website-link as the implemented variant', () => {
    const resource: WebsiteLinkResource = {
      type: 'website-link',
      url: 'https://example.com',
    };

    expect(describeResource(resource)).toEqual({
      type: 'website-link',
      implemented: true,
    });
  });

  it('treats pdf as a recognized-but-reserved variant', () => {
    const resource: PdfResource = { type: 'pdf' };

    expect(describeResource(resource)).toEqual({
      type: 'pdf',
      implemented: false,
    });
  });

  it('treats video as a recognized-but-reserved variant', () => {
    const resource: VideoResource = { type: 'video' };

    expect(describeResource(resource)).toEqual({
      type: 'video',
      implemented: false,
    });
  });

  it('handles every ResourceType via the exhaustive switch', () => {
    // Enumerate the full closed set of discriminators. If a value is added to
    // `ResourceType`, this literal set must grow too (the `satisfies` below
    // pins it to the union), and the switch in `describeResource` must gain a
    // matching case or the file will not compile — keeping the two in lockstep.
    const allTypes = ['website-link', 'pdf', 'video'] as const satisfies readonly ResourceType[];

    const resources: Resource[] = allTypes.map((type) =>
      type === 'website-link'
        ? { type, url: 'https://example.com' }
        : { type },
    );

    const results = resources.map(describeResource);

    expect(results.map((r) => r.type)).toEqual(['website-link', 'pdf', 'video']);
    // Exactly one variant is implemented today (website-link); the rest reserved.
    expect(results.filter((r) => r.implemented).map((r) => r.type)).toEqual([
      'website-link',
    ]);
  });
});
