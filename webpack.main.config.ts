import type { Configuration } from 'webpack';

import { createRules } from './webpack.rules';
import { createPlugins } from './webpack.plugins';
import { aliases } from './webpack.aliases';

const tsConfigFile = 'tsconfig.electron.json';

export const mainConfig: Configuration = {
  /**
   * This is the main entry point for your application, it's the first file
   * that runs in the main process.
   */
  entry: './src/electron/index.ts',
  // Put your normal webpack config below here
  module: {
    rules: createRules(tsConfigFile),
  },
  plugins: createPlugins(tsConfigFile),
  resolve: {
    extensions: ['.js', '.ts', '.jsx', '.tsx', '.json'],
    // Path aliases (@main/*, @ui/*, @shared/*). See webpack.aliases.ts.
    alias: aliases,
  },
};
