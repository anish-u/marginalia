import { useCallback, useEffect, useRef, useState } from 'react';

import { ANNOTATOR_SOURCE } from '@ui/lib/annotator';
import type { WebviewElement } from '@ui/global';
import type { ClipResult, Highlight } from '@shared/highlight';

/**
 * Bridges a React component to the annotator running inside an Electron
 * `<webview>` guest page.
 *
 * The annotator (see `@ui/lib/annotator`) is injected as a string on every
 * `dom-ready` and installs `window.__marginalia` in the guest, exposing
 * `clip()`, `paint(list)` and `scrollTo(id)`. This hook owns that lifecycle and
 * wraps each guest call in an `executeJavaScript` round-trip, so the view only
 * deals with plain functions and a `ready` flag.
 *
 * Returns:
 *  - `webviewRef` — attach to the `<webview>` element.
 *  - `ready` — true once the annotator has been injected into the current page.
 *  - `paint(list)` — re-paint the given highlights onto the page; resolves to
 *    the ids that were located/painted (the rest couldn't be re-anchored, so
 *    the view can flag them — Req 6.6). Empty when the guest isn't ready.
 *  - `scrollTo(id)` — scroll the page to a highlight and flash it.
 *  - `clip()` — clip the current selection, returning a `ClipResult` (or null).
 */
export function useAnnotator() {
  const webviewRef = useRef<WebviewElement | null>(null);
  const [ready, setReady] = useState(false);

  // Inject the annotator into the guest page every time it (re)loads. `ready`
  // gates the Clip action and drives the initial paint.
  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;

    const onDomReady = () => {
      webview
        .executeJavaScript(ANNOTATOR_SOURCE)
        .then(() => setReady(true))
        .catch(() => setReady(false));
    };

    // `dom-ready` isn't in the DOM event map; the webview is still an
    // EventTarget so addEventListener works at runtime.
    webview.addEventListener('dom-ready', onDomReady as EventListener);
    return () => {
      webview.removeEventListener('dom-ready', onDomReady as EventListener);
    };
  }, []);

  const paint = useCallback(async (list: Highlight[]): Promise<string[]> => {
    const webview = webviewRef.current;
    if (!webview) return [];
    try {
      // The guest returns `{ painted: id[] }` (the anchors it could locate).
      // If the guest isn't ready yet the `&&` short-circuits to a falsy value;
      // the next dom-ready repaints, so we just report nothing found for now.
      const result = (await webview.executeJavaScript(
        `window.__marginalia && window.__marginalia.paint(${JSON.stringify(list)})`,
      )) as { painted?: string[] } | false | null | undefined;
      return result && Array.isArray(result.painted) ? result.painted : [];
    } catch {
      /* guest not ready yet; next dom-ready will repaint */
      return [];
    }
  }, []);

  const scrollTo = useCallback((id: string) => {
    const webview = webviewRef.current;
    if (!webview) return;
    webview
      .executeJavaScript(
        `window.__marginalia && window.__marginalia.scrollTo(${JSON.stringify(id)})`,
      )
      .catch(() => {
        /* ignore */
      });
  }, []);

  const clip = useCallback(async (): Promise<ClipResult> => {
    const webview = webviewRef.current;
    if (!webview) return null;
    try {
      return (await webview.executeJavaScript(
        'window.__marginalia && window.__marginalia.clip()',
      )) as ClipResult;
    } catch {
      return null;
    }
  }, []);

  return { webviewRef, ready, paint, scrollTo, clip };
}
