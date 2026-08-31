# Tech Stack

Marginalia is an Electron + React + TypeScript desktop app, built and packaged with Electron Forge and webpack.

## Core stack

- **Electron 44.0.0** (pinned, not a range) — desktop runtime, main + renderer processes.
- **React 19** (`react` / `react-dom` ^19.2.x) — renderer UI.
- **TypeScript ^5.9.3** — strict mode across the codebase.
- **react-router ^8** — client-side routing via `HashRouter` (path-based history breaks under Electron's `file://` / dev-server URLs, so hash routing is intentional).

## UI libraries

- **Tailwind CSS v4** (`tailwindcss` + `@tailwindcss/postcss`, no `tailwind.config` file) with `tw-animate-css`. Styling is configured through `src/ui/index.css` using `@import 'tailwindcss'`, `@theme inline`, and `oklch` color tokens.
- **shadcn/ui** (style "new-york", base color neutral) — components live in `src/ui/components/ui/`. Built on `@radix-ui/react-slot`, `class-variance-authority`, `clsx`, and `tailwind-merge`. Use the `cn()` helper from `@/lib/utils` for class composition.
- **lucide-react** — icons.
- **react-resizable-panels** — underlies the shadcn `Resizable` split view.
- **Tiptap 3** (`@tiptap/react`, `@tiptap/pm`, `@tiptap/starter-kit`) — the rich-text note editor, extended with a custom `highlightQuote` node.

## Build tooling

- **Electron Forge ^7.11** with the webpack plugin. Makers: Squirrel (Windows), ZIP (darwin), DEB, RPM. Fuses plugin hardens the packaged app (RunAsNode off, cookie encryption, ASAR integrity, load-app-from-ASAR only).
- **webpack** with `ts-loader` in `transpileOnly` mode; type-checking is delegated to `fork-ts-checker-webpack-plugin` (separate check for main vs. renderer). CSS pipeline: `style-loader` ← `css-loader` ← `postcss-loader`.
- **ESLint 8** (classic `.eslintrc.json`) extending `eslint:recommended`, `@typescript-eslint` recommended, and `eslint-plugin-import` (recommended/electron/typescript). No Prettier config.

## Package manager & tooling

- Use **npm** (repo has `package-lock.json`; no `packageManager` field or `.nvmrc`).
- No explicit Node engine constraint is declared.

## Commands

```bash
npm start          # electron-forge start — dev with HMR
npm run typecheck  # tsc --build — type-check via project references
npm run lint       # eslint --ext .ts,.tsx .
npm run package    # electron-forge package
npm run make       # electron-forge make — build installers
npm run publish    # electron-forge publish
```

There is **no test script** — no test framework is configured. Do not assume `npm test` exists.

## Verification expectations

After code changes, run `npm run typecheck` and `npm run lint` to verify. TypeScript emit is handled by webpack, so the tsconfigs exist primarily for type-checking and editor navigation — a passing `tsc --build` is the main correctness signal.

## Adding dependencies

Pin or use caret ranges consistent with the existing `package.json`. Electron itself is pinned exactly; keep it that way unless deliberately upgrading. Prefer the libraries already in use (Tailwind v4, shadcn/ui, Tiptap, lucide) over introducing new equivalents.
