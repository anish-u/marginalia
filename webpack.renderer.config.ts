import type { Configuration } from 'webpack';

import { createRules } from './webpack.rules';
import { createPlugins } from './webpack.plugins';
import { aliases } from './webpack.aliases';

const tsConfigFile = 'tsconfig.ui.json';

const rules = createRules(tsConfigFile);

rules.push({
  test: /\.css$/,
  // Loaders run bottom-to-top: postcss (Tailwind) transforms the CSS first,
  // css-loader resolves @import/url(), style-loader injects it into the DOM.
  use: [
    { loader: 'style-loader' },
    { loader: 'css-loader' },
    { loader: 'postcss-loader' },
  ],
});

export const rendererConfig: Configuration = {
  module: {
    rules,
  },
  plugins: createPlugins(tsConfigFile),
  resolve: {
    extensions: ['.js', '.ts', '.jsx', '.tsx', '.css', '.json'],
    // Path aliases (@main/*, @ui/*, @shared/*). See webpack.aliases.ts.
    // The full set is included because Forge bundles preload.ts (which uses
    // @main) as part of the renderer compilation.
    alias: aliases,
  },
};
