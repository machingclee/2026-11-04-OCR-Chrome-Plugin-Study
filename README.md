# Comic Translator Extension

All technical details are documented in the full walkthrough: [Build a Chrome Extension From Scratch: From an Empty Folder to a Page Translated In Place](https://www.machingclee.com/blog/article/Build-a-Chrome-Extension-From-Scratch-From-an-Empty-Folder-to-a-Page-Translated-In-Place)

<img width="1503" height="1140" alt="image" src="https://github.com/user-attachments/assets/8034b371-9d26-4c65-b00a-eac93e50b9bf" />

<img width="798" height="1118" alt="image" src="https://github.com/user-attachments/assets/222839f8-9ab9-4b2a-9d03-c38a6045b865" />

https://github.com/user-attachments/assets/b65dc644-a995-433a-92fa-c67d39a59693

A Manifest V3 extension in React 18 and TypeScript, bundled by Vite. It finds the text on a Japanese comic page, reads each block, translates it with DeepSeek, inpaints the source ink away, and draws the translation at the glyph's size and angle. Several images can run as one queue.

## Install and build

```bash
npm install
npm run build
```

The build writes `dist/`. A prebuild step downloads about 200 MB of models into `public/models` and checks each sha256; the models are not committed.

## Load and use

1. In `chrome://extensions`, turn on Developer mode, choose Load unpacked and select `dist/`. Chrome 116 or later is required.
2. Press `Opt+T` / `Alt+T`, then click an image, or drag over several. Each pick gets a green check badge.
3. Press a badge, the Translate bar, or the right-click item to queue the picks. Images run one at a time and the queue resumes after a worker restart; Stop queue cancels the rest and keeps the finished ones.
4. Right-click with the picker on to choose Show/Hide Translation, or use the popup switch. Drag a label to move it. A reload clears the overlay.

The Debug Client tab shows the det and seg maps, the reader's crops and its answers.

## Settings

The DeepSeek key and effort live in `chrome.storage.local`; effort saves on change, the key with Save settings. Effort applies to translation only, one request per block (four at a time) with the page as context, and defaults to off; the menu also offers low, high and max. Reading always runs at off. No key, no translation.

## Shortcuts

| Keys (Mac / Windows) | Action |
| --- | --- |
| `Opt+T` / `Alt+T` | Start the picker; click or drag images |

The manifest key is a suggestion. Rebind a clash at `chrome://extensions/shortcuts`; the popup prints the bound key.

## Models

| File | Size | Used for |
| --- | --- | --- |
| `comictextdetector.pt.onnx` | 94 MB | det map, one box per line |
| `ppocr_v6_medium_rec.onnx` | 76 MB | on-device line reading |
| `ppocr_v6_dict.txt` | 75 KB | recogniser charset |
| `bubble.onnx` | 11 MB | balloons, for grouping and erase |
| `aot_inpaint_512.onnx` | 22 MB | filling erased ink |

All are under `models/`. `scripts/prepare-assets.ts` fetches and verifies them; the bubble and inpaint models come out of the target project's release archive by byte range.

## Pipeline

| Stage | Runs in | What it does |
| --- | --- | --- |
| Detect | offscreen | det map to one box per line, with the angle |
| Group | offscreen | merge lines into blocks, separate ruby, order columns |
| Read | offscreen | DeepSeek on a block crop and its grid, or PP-OCRv6 per line without a key |
| Translate | service worker | one DeepSeek request per block, cut to fit the source columns |
| Erase | offscreen | AOT inpaint on labelled boxes; flat paper inside a balloon |
| Place | content script | erased page over the image, labels at source size and angle |

Four contexts share one message protocol: `src/App.tsx` (popup and debug client), `src/content-script/pickImage.ts` and `overlay.ts` (picker and drawing), `src/background/index.ts` (queue, translation, erase gate; holds no model), `src/offscreen/main.ts` (sessions and inference).

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | popup in a browser tab |
| `npm run typecheck` | `tsc`, no emit |
| `npm run build` | build id, type-check, bundle to `dist/` |
| `npm run prepare:assets` | fetch and verify models; runs before build |
| `npm run render:page` | render one page's translation headlessly |
| `npm run prompt:lab` | compare prompts on a frozen detection |
| `npm run regression` | replay `fixtures/regression.json` |
| `npm run grid:drift` | measure labels against the ink |

The headless scripts read the DeepSeek key from `.env`. `scripts/probe-detector-outputs.py` prints the detector outputs offline.

## Layout

- `src/lib/detect/`: detector and line boxes. `src/lib/ocr/`: crops, grid, DeepSeek, CTC decode.
- `src/lib/readingOrder.ts`, `fitColumns.ts`, `punct.ts`, `loneGlyph.ts`: merging, ruby, grouping, fitting, lone glyphs, honorifics.
- `src/lib/erase.ts`, `inpaint.ts`, `mask.ts`: erase mask, inpaint tile, paper.
- `src/lib/translationJob.ts`, `translatePrompt.ts`, `translateDeepSeek.ts`, `typeset.ts`: translation and layout.
- `src/lib/regions.ts`, `scoreOverlay.ts`: debug previews. `src/shared/`: constants, types, factories.

## Docs and open work

`docs/detection-pipeline.md` covers the detector rewrite, `docs/regression.md` the cases, and `docs/loops/` the dated records.

The open cases are the three-column TV speech on `fixtures/page-forty.jpg`, where the reader merges or splits the columns between runs, and the three-line balloon in `docs/handoff-four-columns.md` that renders as four columns. `docs/loops/2026-11-18-04-three-columns.md` records the TV rounds and what was reverted.
