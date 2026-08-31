/**
 * Guest-page annotator.
 *
 * This code does NOT run in the renderer. It is injected into the `<webview>`
 * guest page via `webview.executeJavaScript(ANNOTATOR_SOURCE)` on `dom-ready`,
 * so it executes in the page's own document where the DOM and the CSS Custom
 * Highlight API live. It installs a small API on the guest `window` under
 * `__marginalia` that the host drives:
 *
 *   __marginalia.clip()            -> ClipResult (text-quote anchor | null)
 *   __marginalia.paint(anchors)    -> re-find each anchor and highlight it
 *   __marginalia.scrollTo(id)      -> scroll the anchor into view and flash it
 *
 * We keep it as a single self-contained IIFE string (no imports, no bundler)
 * because it has to be evaluated as source inside another document. Types here
 * are only for our own editing sanity; the emitted string is plain JS.
 *
 * Anchoring strategy: text-quote. We flatten the page's visible text, find the
 * selected `text` using `prefix`/`suffix` context to disambiguate repeats, then
 * map the flat offset range back onto real DOM text nodes to build a `Range`.
 * Painting uses `CSS.highlights` so we never mutate the page's DOM.
 */

/** Length of context captured/used on each side of a selection. */
const CONTEXT_LEN = 32;

/**
 * The source string injected into the guest page. Written as a template so it
 * stays readable; `CONTEXT_LEN` is interpolated in. Everything inside runs in
 * the guest, not here.
 */
export const ANNOTATOR_SOURCE = `(() => {
  const CONTEXT_LEN = ${CONTEXT_LEN};
  const HIGHLIGHT_NAME = 'marginalia-highlight';
  const FLASH_NAME = 'marginalia-flash';

  // Install once — re-injection on navigation is fine, but don't stack state.
  if (window.__marginalia) {
    return true;
  }

  // Anchors we currently know about, by id, so paint() is idempotent and
  // scrollTo() can re-find them.
  const anchors = new Map();

  // Register a stylesheet for the custom highlights (::highlight() can't be set
  // inline). Guarded so we only add it once.
  const ensureStyles = () => {
    if (document.getElementById('marginalia-style')) return;
    const style = document.createElement('style');
    style.id = 'marginalia-style';
    // Marginalia Green (#C2F9BB → 194,249,187) for the resting highlight, so a
    // clip reads like a handwritten annotation on the page. The flash uses the
    // brand Deep Green (#294B32 → 41,75,50) so "jump to clip" pulses on-brand
    // and stays distinct from the resting tint. Colors are hard-coded here (not
    // CSS vars) because this string runs inside the arbitrary guest document.
    style.textContent =
      '::highlight(' + HIGHLIGHT_NAME + '){background-color:rgba(194,249,187,.55);color:inherit;}' +
      '::highlight(' + FLASH_NAME + '){background-color:rgba(41,75,50,.5);color:inherit;}';
    document.head.appendChild(style);
  };

  // Walk visible text nodes in document order, building a flat string plus a map
  // from flat offsets back to {node, offset}. Skips script/style/hidden nodes.
  const buildTextIndex = () => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        const tag = parent.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') {
          return NodeFilter.FILTER_REJECT;
        }
        if (!node.nodeValue || node.nodeValue.length === 0) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let text = '';
    const segments = []; // { start, end, node }
    let node;
    while ((node = walker.nextNode())) {
      const value = node.nodeValue;
      segments.push({ start: text.length, end: text.length + value.length, node });
      text += value;
    }
    return { text, segments };
  };

  // Map a flat [start,end) range onto a DOM Range using the segment index.
  const flatRangeToDomRange = (segments, start, end) => {
    let startNode = null, startOffset = 0, endNode = null, endOffset = 0;
    for (const seg of segments) {
      if (startNode === null && start >= seg.start && start < seg.end) {
        startNode = seg.node;
        startOffset = start - seg.start;
      }
      if (end > seg.start && end <= seg.end) {
        endNode = seg.node;
        endOffset = end - seg.start;
        break;
      }
    }
    if (!startNode || !endNode) return null;
    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    return range;
  };

  // Find the best flat offset for an anchor. Prefer a match whose surrounding
  // context matches prefix/suffix; fall back to the first plain text match.
  const locate = (flat, anchor) => {
    const { text, prefix, suffix } = anchor;
    if (!text) return -1;
    let from = 0;
    let fallback = -1;
    while (true) {
      const idx = flat.indexOf(text, from);
      if (idx === -1) break;
      if (fallback === -1) fallback = idx;
      const before = flat.slice(Math.max(0, idx - CONTEXT_LEN), idx);
      const after = flat.slice(idx + text.length, idx + text.length + CONTEXT_LEN);
      const prefixOk = !prefix || before.endsWith(prefix.slice(-CONTEXT_LEN));
      const suffixOk = !suffix || after.startsWith(suffix.slice(0, CONTEXT_LEN));
      if (prefixOk && suffixOk) return idx;
      from = idx + 1;
    }
    return fallback;
  };

  const rangeFor = (anchor) => {
    const { text: flat, segments } = buildTextIndex();
    const idx = locate(flat, anchor);
    if (idx === -1) return null;
    return flatRangeToDomRange(segments, idx, idx + anchor.text.length);
  };

  // Rebuild the persistent highlight from all known anchors.
  const repaint = () => {
    if (!('highlights' in CSS) || typeof Highlight === 'undefined') return;
    ensureStyles();
    const hl = new Highlight();
    for (const anchor of anchors.values()) {
      const range = rangeFor(anchor);
      if (range) hl.add(range);
    }
    CSS.highlights.set(HIGHLIGHT_NAME, hl);
  };

  window.__marginalia = {
    clip() {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
      const text = sel.toString();
      if (!text.trim()) return null;

      // Derive prefix/suffix from the flat page text around the selection so
      // they match how we re-locate later.
      const { text: flat } = buildTextIndex();
      const idx = flat.indexOf(text);
      const prefix = idx > 0 ? flat.slice(Math.max(0, idx - CONTEXT_LEN), idx) : '';
      const suffix = idx >= 0 ? flat.slice(idx + text.length, idx + text.length + CONTEXT_LEN) : '';

      sel.removeAllRanges();
      return { text, prefix, suffix, url: location.href };
    },

    paint(list) {
      anchors.clear();
      for (const a of list) anchors.set(a.id, a);
      repaint();
      return true;
    },

    scrollTo(id) {
      const anchor = anchors.get(id);
      if (!anchor) return false;
      const range = rangeFor(anchor);
      if (!range) return false;

      const rect = range.getBoundingClientRect();
      window.scrollTo({
        top: window.scrollY + rect.top - window.innerHeight / 3,
        behavior: 'smooth',
      });

      // Flash: paint a temporary highlight, then clear it.
      if ('highlights' in CSS && typeof Highlight !== 'undefined') {
        ensureStyles();
        const flash = new Highlight();
        flash.add(range);
        CSS.highlights.set(FLASH_NAME, flash);
        setTimeout(() => CSS.highlights.delete(FLASH_NAME), 1200);
      }
      return true;
    },
  };

  return true;
})();`;
