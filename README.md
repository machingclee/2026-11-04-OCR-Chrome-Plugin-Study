# Comic Translator Extension

All technical details are documented in the full walkthrough: [Build a Chrome Extension From Scratch: From an Empty Folder to a Page Translated In Place](https://www.machingclee.com/blog/article/Build-a-Chrome-Extension-From-Scratch-From-an-Empty-Folder-to-a-Page-Translated-In-Place)


<img width="1503" height="1140" alt="image" src="https://github.com/user-attachments/assets/8034b371-9d26-4c65-b00a-eac93e50b9bf" />

<img width="798" height="1118" alt="image" src="https://github.com/user-attachments/assets/222839f8-9ab9-4b2a-9d03-c38a6045b865" />

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
4. Press `Opt+T` / `Alt+T` on a page (or press Pick an image in the debug
   view), then click an image. It gets a check mark, and that check mark
   translates the page in place. Detect boxes only inspects the detection in
   the popup. With the picker on, right-click an image and choose **Show/Hide
   Translation** to compare the result with the original page; the item is
   greyed out on a page that has no translation yet. The **Translation** switch
   in the popup does the same thing. The stored result belongs to the document
   it was picked from, so a page reload clears it and the popup starts empty.

## Open work

`docs/handoff-four-columns.md` is an open bug handed over with its pipeline map,
the failing case, what has been tried and the diagnostics that would pin it down.

## Settings

The popup stores the DeepSeek key, the translation effort and the inference
device in `chrome.storage.local`, so they survive a browser restart. The effort is written
the moment the menu changes; the key is only written when **Save settings** is
pressed.

The effort applies to translation only, one request per block, and defaults to
high. Reading a block — transcribing the text and placing it on the grid — never
thinks. The API maps every level onto low, high or max, so the popup offers off,
low, high and max.

## Shortcuts

| Keys (Mac / Windows) | Action |
| --- | --- |
| `Opt+T` / `Alt+T` | Pick comic images on the page; drag to select several |

The keys in `manifest.json` are suggestions. If one clashes with another
extension, rebind it at `chrome://extensions/shortcuts`; the popup reads the
bound key and prints it in its hint box.

## When detection seems stuck

The batch pill shows how many seconds the current stage has run, and when a
batch fails it prints the failing item's reason. Before those two, a stage that
never returned and a stage that was merely slow looked the same, and a failed
batch said only `1 failed`.

Every wait now has a deadline, and a missed deadline is an error that names the
model and the stage:

| Wait | Deadline |
| --- | --- |
| Page image download | 20 s |
| Image decode | 60 s |
| Each model load | 180 s |
| Each inference pass | 120 s |
| One whole detection (service-worker watchdog) | 10 min |

The reason is also in the page's console and in the offscreen document's
console, which is where the detail lives if the pill is not enough:

1. Open `chrome://extensions`, find Comic Translator, click **Inspect views:
   service worker** (and **offscreen.html** if it is listed).
2. The offscreen console logs `[detect] <stage>` as the pass moves, and
   `[inference] <model> loaded in … on wasm` after each model loads.
3. A pass that stops after `[detect] detecting text lines` was inside the
   detector; one that stops at `downloading the page image` never got the
   bytes.

Inference runs on the GPU by default, because the detector on the CPU is slow.
The device is the **Inference device** menu in the popup; it is saved the moment
it changes, and the offscreen document drops its sessions so the next detection
reloads the models on the new device. The same setting from a console is:

```js
chrome.storage.local.set({ inferenceBackend: 'wasm' });  // CPU: stable, slow
chrome.storage.local.set({ inferenceBackend: 'webgpu' }); // GPU: fast
```

GPU is the one failure this extension can cause that takes the whole browser
with it: when the GPU process wedges, the toolbar stops responding too. Two
things stand between a bad GPU and a silent hang. Before the 94 MB detector
loads, a five-second probe asks for a GPU device; if the probe fails or times
out, the page uses CPU. And a WebGPU load or run that fails or times out
downgrades that page to CPU, so one bad GPU is not retried for every model. The
probe cannot save a driver that wedges mid-inference, so if Chrome freezes
while a page is detecting, switch the device to CPU.

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
                                 detector  : det map → line seeds → glyph
                                             strokes → one box per column
                                 bubble    : 640 YOLOv8 seg → balloons
                                 recogniser: per line crop → CTC decode, or a
                                             cloud model over the same crops
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
- `npm run zip` packs `dist/` into `dist.zip`, with `manifest.json` at the
  archive root so the zip uploads to the Web Store and unzips loadable.
  `scripts/zip-dist.sh [out.zip]` does the same from a shell.
- `scripts/prepare-assets.ts` downloads and verifies the models.
- `scripts/probe-detector-outputs.py` prints the detector outputs offline.

## Layout

- `src/lib/detect/` runs the detector and turns the det and seg maps into line boxes.
- `src/lib/rect.ts` fits the minimum area rectangle, which gives the slant.
- `src/lib/warp.ts` turns an angle into an upright crop.
- `src/lib/readingOrder.ts` merges, separates ruby, groups by region, orders.
- `src/lib/erase.ts` paints the seg mask out of a crop preview before it is shown.
- `src/lib/bubble.ts` decodes the balloon segmentation.
- `src/lib/ocr` crops, normalises, and decodes each line.
- `src/lib/ocr/cloudOcr.ts` sends one crop per block to DeepSeek, which returns the regions, their text and their layout; the boxes stay local.
- `src/lib/ocr/grid.ts` draws the grid on a block crop and maps the cell box the reader answers with back to page pixels.
- `src/shared` holds the constants, types, and message factories.
