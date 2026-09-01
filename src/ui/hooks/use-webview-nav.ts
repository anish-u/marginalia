import { useCallback, useEffect, useState, type RefObject } from 'react';

import type { WebviewElement } from '@ui/global';

/**
 * Tracks navigation state of an Electron `<webview>` and exposes controls, so
 * the resource-note browser pane can have a proper back/forward/reload +
 * address bar (previously the pane had no navigation at all).
 *
 * Shares the same `webviewRef` as `useAnnotator` — the two hooks observe
 * different aspects of one element. This hook subscribes to the webview's
 * navigation lifecycle events (`did-navigate`, `did-navigate-in-page`, and the
 * start/stop loading events) to keep `currentUrl`, `canGoBack`, `canGoForward`,
 * and `loading` in sync with what the guest page is actually doing.
 *
 * @param webviewRef ref to the `<webview>` element (same one useAnnotator holds)
 * @param initialUrl the URL the pane starts on, so the address bar isn't blank
 *   before the first navigation event fires
 */
export function useWebviewNav(
  webviewRef: RefObject<WebviewElement | null>,
  initialUrl: string,
) {
  const [currentUrl, setCurrentUrl] = useState(initialUrl);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [loading, setLoading] = useState(false);

  // Keep the address bar seeded with the initial/loaded URL until the webview
  // reports its own navigation. (A loaded note overwrites `initialUrl`, so this
  // also picks up the note's resource url.)
  useEffect(() => {
    setCurrentUrl(initialUrl);
  }, [initialUrl]);

  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;

    // Read live back/forward availability after each navigation. Guarded in a
    // try/catch because these throw if called before the guest is attached.
    const syncNavState = () => {
      try {
        setCanGoBack(webview.canGoBack());
        setCanGoForward(webview.canGoForward());
        setCurrentUrl(webview.getURL());
      } catch {
        /* not attached yet; the next event will sync */
      }
    };

    const onDidNavigate = () => syncNavState();
    const onStartLoading = () => setLoading(true);
    const onStopLoading = () => {
      setLoading(false);
      syncNavState();
    };

    // These aren't in the DOM event map but the webview is an EventTarget, so
    // addEventListener works at runtime.
    webview.addEventListener('did-navigate', onDidNavigate as EventListener);
    webview.addEventListener(
      'did-navigate-in-page',
      onDidNavigate as EventListener,
    );
    webview.addEventListener('did-start-loading', onStartLoading as EventListener);
    webview.addEventListener('did-stop-loading', onStopLoading as EventListener);

    return () => {
      webview.removeEventListener('did-navigate', onDidNavigate as EventListener);
      webview.removeEventListener(
        'did-navigate-in-page',
        onDidNavigate as EventListener,
      );
      webview.removeEventListener(
        'did-start-loading',
        onStartLoading as EventListener,
      );
      webview.removeEventListener(
        'did-stop-loading',
        onStopLoading as EventListener,
      );
    };
  }, [webviewRef]);

  const goBack = useCallback(() => {
    if (webviewRef.current?.canGoBack()) webviewRef.current.goBack();
  }, [webviewRef]);

  const goForward = useCallback(() => {
    if (webviewRef.current?.canGoForward()) webviewRef.current.goForward();
  }, [webviewRef]);

  const reload = useCallback(() => {
    webviewRef.current?.reload();
  }, [webviewRef]);

  /**
   * Navigate to a user-entered address. Normalizes a bare host to https:// and
   * ignores empty input. Errors from an invalid URL are swallowed (the address
   * bar simply stays put).
   */
  const navigate = useCallback(
    (raw: string) => {
      const webview = webviewRef.current;
      if (!webview) return;
      const trimmed = raw.trim();
      if (trimmed === '') return;
      const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
        ? trimmed
        : `https://${trimmed}`;
      try {
        // Validate before loading so a typo doesn't throw into the render path.
        const href = new URL(candidate).href;
        void webview.loadURL(href);
      } catch {
        /* invalid address — leave the pane where it is */
      }
    },
    [webviewRef],
  );

  return {
    currentUrl,
    canGoBack,
    canGoForward,
    loading,
    goBack,
    goForward,
    reload,
    navigate,
  };
}
