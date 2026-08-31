import { app, session } from 'electron';

/**
 * Content-Security-Policy applied to every response.
 *
 * Production is strict: scripts and styles may only come from the app itself.
 * Development relaxes two things that the webpack dev server needs:
 *   - `'unsafe-eval'` in script-src — HMR evaluates hot module updates via eval
 *   - `ws:`/`http:` in connect-src — the dev server talks over a websocket
 * `'unsafe-inline'` in style-src is kept in both because style-loader injects
 * styles as inline <style> tags.
 */
const buildCsp = (isDev: boolean): string => {
  const scriptSrc = isDev ? "'self' 'unsafe-eval'" : "'self'";
  const connectSrc = isDev ? "'self' ws: http:" : "'self'";
  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    `connect-src ${connectSrc}`,
  ].join('; ');
};

/**
 * Attaches the CSP header to the app's own renderer responses only.
 *
 * The `<webview>` in the resource-note window loads external sites (google.com,
 * medium.com, …) through this same default session. Those pages ship their own
 * CSPs — or none — and forcing our strict app policy onto them breaks their
 * images, fonts, scripts, and network calls. So we skip any response that
 * originated from a webview (`webContents.getType() === 'webview'`) and only
 * harden requests coming from our app windows.
 */
export const installContentSecurityPolicy = (): void => {
  const csp = buildCsp(!app.isPackaged);
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    // Leave guest webview pages untouched — they manage their own CSP.
    if (details.webContents?.getType() === 'webview') {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    });
  });
};
