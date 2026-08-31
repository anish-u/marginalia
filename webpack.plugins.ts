import type IForkTsCheckerWebpackPlugin from 'fork-ts-checker-webpack-plugin';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ForkTsCheckerWebpackPlugin: typeof IForkTsCheckerWebpackPlugin = require('fork-ts-checker-webpack-plugin');

/**
 * Builds the plugin list for a process. The type checker runs against the
 * process-specific tsconfig so main and renderer are validated with their own
 * lib/JSX settings (ts-loader itself runs in `transpileOnly` mode).
 */
export const createPlugins = (tsConfigFile: string) => [
  new ForkTsCheckerWebpackPlugin({
    logger: 'webpack-infrastructure',
    typescript: {
      configFile: tsConfigFile,
    },
  }),
];
