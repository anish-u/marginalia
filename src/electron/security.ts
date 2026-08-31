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

/** Attaches the CSP header to all responses for the default session. */
export const installContentSecurityPolicy = (): void => {
  const csp = buildCsp(!app.isPackaged);
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    });
  });
};
