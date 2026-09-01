// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

/**
 * Regression test for highlight re-paint on browser-pane navigation (Req 5.1).
 *
 * The bug: `useAnnotator` re-injects the annotator on every `dom-ready`, but the
 * consumer's repaint effect was keyed on the boolean `ready`, which only flips
 * `false → true` once. So a *second* `dom-ready` (the user navigated away and
 * back — a fresh guest document with an empty annotator) re-injected but never
 * re-painted, and the highlights vanished.
 *
 * The fix exposes `readyTick`, a counter bumped on *every* successful injection.
 * These tests lock that behavior in at the hook level:
 *   - `readyTick` increments on each simulated `dom-ready` (after the injecting
 *     `executeJavaScript` resolves), not just the first.
 *   - A consumer effect keyed on `readyTick` re-runs after a *second* `dom-ready`
 *     — i.e. the repaint fires again on navigation, which is the actual defect.
 *
 * Rather than mount an Electron `<webview>` (unavailable under jsdom), we stand
 * a fake webview element on a real `EventTarget`: `addEventListener`/
 * `removeEventListener` come from `EventTarget`, and we stub `executeJavaScript`
 * so the injection resolves. Dispatching a `dom-ready` event then faithfully
 * reproduces a guest (re)load. The hook attaches its listener via a ref effect,
 * so we hand it the fake element through the returned `webviewRef`.
 *
 * Validates: Requirements 5.1
 */

import { act, render, renderHook } from '@testing-library/react';
import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useAnnotator } from '@ui/hooks/use-annotator';
import type { WebviewElement } from '@ui/global';

// --- Fake webview ----------------------------------------------------------

/**
 * A minimal `<webview>` stand-in. Real `addEventListener`/`removeEventListener`
 * (inherited from EventTarget) so the hook's `dom-ready` wiring works exactly as
 * in the app; `executeJavaScript` is a spy that resolves so the injection's
 * `.then()` runs and bumps the counter. `fireDomReady()` reproduces a guest
 * (re)load.
 */
class FakeWebview extends EventTarget {
  executeJavaScript = vi.fn().mockResolvedValue(undefined);

  fireDomReady() {
    this.dispatchEvent(new Event('dom-ready'));
  }
}

/** Cast the fake to the element type the hook's ref expects. */
const asWebview = (fake: FakeWebview) => fake as unknown as WebviewElement;

afterEach(() => {
  vi.restoreAllMocks();
});

// --- readyTick increments per dom-ready ------------------------------------

describe('useAnnotator — readyTick bumps on every (re)injection (Req 5.1)', () => {
  it('starts at 0 and increments on each successful dom-ready', async () => {
    const fake = new FakeWebview();

    // The hook attaches its `dom-ready` listener in a mount effect that reads
    // `webviewRef.current` once. In the app the `<webview>` is rendered with
    // `ref={webviewRef}`, so React populates the ref during render — before
    // effects fire. Reproduce that timing by assigning the ref synchronously in
    // the render callback (a mutable-ref write during render is fine here and is
    // the only way to have the ref set before the hook's mount effect runs).
    const { result } = renderHook(() => {
      const api = useAnnotator();
      (api.webviewRef as RefObject<WebviewElement | null>).current =
        asWebview(fake);
      return api;
    });

    // Before any load: not ready, tick at 0.
    expect(result.current.ready).toBe(false);
    expect(result.current.readyTick).toBe(0);

    // First guest load. `act` + `await` lets the injecting executeJavaScript
    // promise resolve and its `.then()` (which bumps state) flush.
    await act(async () => {
      fake.fireDomReady();
    });

    expect(result.current.ready).toBe(true);
    expect(result.current.readyTick).toBe(1);

    // Second guest load — the navigation-away-and-back case. The boolean
    // `ready` stays true, but the tick MUST advance so a repaint re-fires.
    await act(async () => {
      fake.fireDomReady();
    });

    expect(result.current.readyTick).toBe(2);

    // A third, for good measure: it keeps counting, one per dom-ready.
    await act(async () => {
      fake.fireDomReady();
    });

    expect(result.current.readyTick).toBe(3);

    // The annotator was (re)injected once per dom-ready.
    expect(fake.executeJavaScript).toHaveBeenCalledTimes(3);
  });

  it('does not bump readyTick when injection fails', async () => {
    const fake = new FakeWebview();
    fake.executeJavaScript.mockRejectedValue(new Error('guest went away'));

    const { result, rerender } = renderHook(() => useAnnotator());
    result.current.webviewRef.current = asWebview(fake);
    rerender();

    await act(async () => {
      fake.fireDomReady();
    });

    // Injection rejected → not ready, and the counter stays put (only a
    // *successful* injection means the annotator is present to repaint against).
    expect(result.current.ready).toBe(false);
    expect(result.current.readyTick).toBe(0);
  });
});

// --- The consumer's repaint re-runs on a second dom-ready ------------------

describe('useAnnotator — consumer repaint re-runs after navigation (Req 5.1)', () => {
  it('an effect keyed on readyTick fires again on the second dom-ready', async () => {
    const fake = new FakeWebview();
    const repaint = vi.fn();

    /**
     * A stand-in for `ResourceNoteView`'s repaint effect: it depends on
     * `readyTick` and calls a `repaint` spy each time the tick changes — exactly
     * the shape of the view's `useEffect(..., [ready, readyTick, highlights,
     * paint])`. If the hook only signalled the first load, this effect would run
     * once and the second navigation would silently drop the highlights.
     */
    function Consumer({ webview }: { webview: WebviewElement }) {
      const { webviewRef, readyTick } = useAnnotator();
      const attached = useRef(false);
      if (!attached.current) {
        webviewRef.current = webview;
        attached.current = true;
      }
      useEffect(() => {
        // Skip the initial mount tick (0); only count actual (re)loads, which
        // is what the view's repaint keyed on readyTick does.
        if (readyTick > 0) repaint(readyTick);
      }, [readyTick]);
      return null;
    }

    render(<Consumer webview={asWebview(fake)} />);

    // First load → repaint once.
    await act(async () => {
      fake.fireDomReady();
    });
    expect(repaint).toHaveBeenCalledTimes(1);
    expect(repaint).toHaveBeenLastCalledWith(1);

    // Navigate away and back → the effect MUST run again (the regression).
    await act(async () => {
      fake.fireDomReady();
    });
    expect(repaint).toHaveBeenCalledTimes(2);
    expect(repaint).toHaveBeenLastCalledWith(2);
  });
});
