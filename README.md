# Comic Translator Extension

A Manifest V3 extension built with React 18 and TypeScript, bundled by Vite.

## Install and build

```bash
npm install
npm run build
```

The build writes the loadable package to `dist/`.

## Load it

1. Open `chrome://extensions`.
2. Turn on Developer mode.
3. Choose Load unpacked and select the `dist` directory.
4. Click the extension icon. The popup shows a Hello World message.

## Scripts

- `npm run dev` serves the popup in a normal browser tab for quick layout work.
- `npm run typecheck` runs `tsc` with no emit.
- `npm run build` type-checks and bundles into `dist/`.

## Files

- `public/manifest.json` is copied into `dist/` by Vite.
- `popup.html` is the Rollup entry, so the bundle is named `popup.html`.
- `src/main.tsx` mounts React into `#root`.
- `src/App.tsx` is the Hello World component.
