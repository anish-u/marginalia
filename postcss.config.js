/**
 * PostCSS configuration.
 *
 * Tailwind CSS v4 ships its PostCSS integration as a dedicated plugin package
 * (`@tailwindcss/postcss`) rather than using the `tailwindcss` package directly
 * as a v3-style plugin. This config is consumed by `postcss-loader`, which is
 * wired into the renderer webpack config only (the main process has no CSS).
 */
module.exports = {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};
