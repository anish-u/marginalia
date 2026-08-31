/**
 * Guards `Element.prototype.setPointerCapture` against a Chromium/Electron edge
 * case triggered by `react-resizable-panels`.
 *
 * When a resize drag starts, the library calls `separator.setPointerCapture()`.
 * In a window that hosts an Electron `<webview>` (an out-of-process frame),
 * the pointer event stream on the host document can be interrupted such that
 * the `pointerId` is no longer active when capture is attempted. Chromium then
 * throws `InvalidStateError: Failed to execute 'setPointerCapture'...`, which
 * surfaces as an uncaught error from the library's document-level listener (so
 * a React error boundary can't catch it).
 *
 * The ResourceNoteView covers the webview with an overlay during drags to keep
 * the pointer on the host document, but the very first capture call can still
 * race ahead of that overlay mounting. This shim swallows *only* that specific
 * throw — capture is a best-effort optimization for pointer tracking, and the
 * library already tolerates it being unavailable (it calls it with `?.`), so a
 * no-op on failure is safe. All other errors are rethrown unchanged.
 *
 * Idempotent: installing twice is a no-op. Call once at renderer startup.
 */

let installed = false;

export function installPointerCaptureGuard(): void {
  if (installed) return;
  if (typeof Element === 'undefined') return;

  const original = Element.prototype.setPointerCapture;
  if (typeof original !== 'function') return;

  Element.prototype.setPointerCapture = function patched(
    this: Element,
    pointerId: number,
  ): void {
    try {
      original.call(this, pointerId);
    } catch (err) {
      // Only tolerate the known "no active pointer" case; rethrow anything else.
      if (err instanceof DOMException && err.name === 'InvalidStateError') {
        return;
      }
      throw err;
    }
  };

  installed = true;
}
