import type { ModuleOptions } from 'webpack';

/**
 * Builds the webpack module rules for a given process.
 *
 * The ts-loader `configFile` is parameterised so the Electron main/preload
 * bundle type-checks against `tsconfig.electron.json` (Node libs) while the
 * renderer uses `tsconfig.ui.json` (DOM libs + React JSX). A factory is used
 * instead of a shared mutable array so the two configs never leak rules into
 * each other.
 */
export const createRules = (
  tsConfigFile: string,
): Required<ModuleOptions>['rules'] => [
  // Add support for native node modules
  {
    // We're specifying native_modules in the test because the asset relocator loader generates a
    // "fake" .node file which is really a cjs file.
    test: /native_modules[/\\].+\.node$/,
    use: 'node-loader',
  },
  {
    test: /[/\\]node_modules[/\\].+\.(m?js|node)$/,
    parser: { amd: false },
    use: {
      loader: '@vercel/webpack-asset-relocator-loader',
      options: {
        outputAssetBase: 'native_modules',
      },
    },
  },
  {
    test: /\.tsx?$/,
    exclude: /(node_modules|\.webpack)/,
    use: {
      loader: 'ts-loader',
      options: {
        transpileOnly: true,
        configFile: tsConfigFile,
      },
    },
  },
];
