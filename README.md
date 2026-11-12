# Comic Translator Extension

All technical details are documented in the full walkthrough: [Build a Chrome Extension From Scratch: From an Empty Folder to a Page Translated In Place](https://www.machingclee.com/blog/article/Build-a-Chrome-Extension-From-Scratch-From-an-Empty-Folder-to-a-Page-Translated-In-Place)

https://github.com/user-attachments/assets/b65dc644-a995-433a-92fa-c67d39a59693

A Manifest V3 extension built with React 18 and TypeScript, bundled by Vite.

It reads the comic image on the current page, finds the text lines, recognises
what each one says, groups them by speech balloon, and places the translation as
absolutely positioned text over the image in the page.

## Install and build

```bash
npm install
npm run build
```

The build writes the loadable package to `dist/`. It also downloads and verifies
the models, which are not committed.

## Load it

1. Open `chrome://extensions`.
2. Turn on Developer mode.
3. Choose Load unpacked and select the `dist` directory.
4. Pick an image on a page, press Detect boxes, then Translate the page.
   The translation is placed over the image in the tab; Clear overlay removes it.

## Models

| File | Size | Used for |
| --- | --- | --- |
| `models/comictextdetector.pt.onnx` | 94 MB | text lines from the det map |
| `models/ppocr_v6_medium_rec.onnx` | 76 MB | reading each line |
| `models/ppocr_v6_dict.txt` | 75 KB | charset for the recogniser |
| `models/bubble.onnx` | 11 MB | speech balloons, for grouping |

`scripts/prepare-assets.ts` fetches them, checks each sha256, and writes them to
`public/models`. The bubble model comes out of the target project's release
archive by reading only the byte range that holds it.

## Pipeline

```
Popup  →  Service worker  →  Offscreen document
                                 detector  : det map → components → unclip
                                             blk rows → blocks
                                 bubble    : 640 YOLOv8 seg → balloons
                                 recogniser: per line crop → CTC decode
                                 overlay   : translated boxes → page DOM
                                 regions   : blocks first, balloons after
```

Four contexts, one message protocol:

- `src/popup` and `src/App.tsx` own the interface.
- `src/content-script/pickImage.ts` runs in the page, marks the picked image, and stores its url.
- `src/content-script/overlay.ts` wraps that image and positions the translation over it.
- `src/background/index.ts` coordinates and keeps no model in memory.
- `src/offscreen/main.ts` holds the sessions and does the work.

## Scripts

- `npm run dev` serves the popup in a normal browser tab for layout work.
- `npm run typecheck` runs `tsc` with no emit.
- `npm run build` stamps a build id, type-checks, and bundles into `dist/`.
- `scripts/prepare-assets.ts` downloads and verifies the models.
- `scripts/probe-detector-outputs.py` prints the detector outputs offline.

## Layout

- `src/lib/detector.ts` turns the det and blk outputs into line boxes.
- `src/lib/rect.ts` fits the minimum area rectangle, which gives the slant.
- `src/lib/warp.ts` turns an angle into an upright crop.
- `src/lib/readingOrder.ts` merges, separates ruby, groups by region, orders.
- `src/lib/erase.ts` paints the seg mask out of a crop preview before it is shown.
- `src/lib/bubble.ts` decodes the balloon segmentation.
- `src/lib/ocr` crops, normalises, and decodes each line.
- `src/shared` holds the constants, types, and message factories.
