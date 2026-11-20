# Comic Translator Extension

<img width="1503" height="1140" alt="image" src="https://github.com/user-attachments/assets/8034b371-9d26-4c65-b00a-eac93e50b9bf" />

A Manifest V3 extension in React 18 and TypeScript, bundled by Vite. It finds the text on a Japanese comic page, reads each block, translates it with DeepSeek, inpaints the source ink away, and draws the translation at the glyph's size and angle. Several images can run as one queue.

All technical details are documented in the full walkthrough: [Build a Chrome Extension From Scratch: From an Empty Folder to a Page Translated In Place](https://www.machingclee.com/blog/article/Build-a-Chrome-Extension-From-Scratch-From-an-Empty-Folder-to-a-Page-Translated-In-Place)

## App Layout as a Chrome Popup Window

<img width="1042" height="604" alt="image" src="https://github.com/user-attachments/assets/a7be5760-c6fa-4f1d-a626-90a51e060bc3" />

## Inpainting and Translation

<img width="600" alt="image" src="https://github.com/user-attachments/assets/8034b371-9d26-4c65-b00a-eac93e50b9bf" />

<img width="600" alt="image" src="https://github.com/user-attachments/assets/222839f8-9ab9-4b2a-9d03-c38a6045b865" />

## Video (Speed of ONNX box detection + OCR + CloudOCR via LLM + final LLM Translation)

https://github.com/user-attachments/assets/ef98c1e0-05fe-49b5-a218-e226f141de7f

**Remark.** Only images recognized as text region will be sent to LLM, it is not reading the entire page, for example:

<img width="283" height="366" alt="image" src="https://github.com/user-attachments/assets/06eb110a-6a1f-4f59-a4e6-40fec7511a83" />

Each image is cropped by yellow rectangles before being sent to the LLM for the OCR process, which significantly reduces the number of tokens needed just for the OCR process.

## Install and build

```bash
npm install
npm run build
```

The build writes `dist/`. A prebuild step downloads about 200 MB of models into `public/models` and checks each sha256; the models are not committed.

## Load and use

<<<<<<< HEAD

1. In `chrome://extensions`, turn on Developer mode, choose Load unpacked and select `dist/`. Chrome 116 or later is required.
2. Press `Opt+T` / `Alt+T`, then click an image, or drag over several. Each pick gets a green check badge.
3. Press a badge, the Translate bar, or the right-click item to queue the picks. Images run one at a time and the queue resumes after a worker restart; Stop queue cancels the rest and keeps the finished ones.
4. # Right-click with the picker on to choose Show/Hide Translation, or use the popup switch. Drag a label to move it. A reload clears the overlay.
5. Open `chrome://extensions`.
6. Turn on Developer mode.
7. Choose Load unpacked and select the `dist` directory.
8. Press `Opt+T` / `Alt+T` on a page (or press Pick an image in the debug
   view), then click an image. It gets a check mark, and that check mark
   translates the page in place. Detect boxes only inspects the detection in
   the popup. With the picker on, right-click an image for more functionality,
   such as **Show/Hide Translation** to compare the result with the original
   page. The **Translation** switch in the popup does the same thing. The stored
   result belongs to the document it was picked from, so a page reload clears it
   and the popup starts empty.
   > > > > > > > 648dada55205fef0e4792a299b8f275135beb9d1

The Debug Client tab shows the det and seg maps, the reader's crops and its answers.

## Settings

<<<<<<< HEAD
The DeepSeek key and effort live in `chrome.storage.local`; effort saves on change, the key with Save settings. Effort applies to translation only, one request per block (four at a time) with the page as context, and defaults to off; the menu also offers low, high and max. Reading always runs at off. No key, no translation.
=======
The popup stores the DeepSeek key, the translation effort and the inference
device in `chrome.storage.local`, so they survive a browser restart. The effort is written
the moment the menu changes; the key is only written when **Save settings** is
pressed.

The effort applies to translation only, one request per block, and defaults to
high. Reading a block — transcribing the text and placing it on the grid — never
thinks. The API maps every level onto low, high or max, so the popup offers off,
low, high and max.

> > > > > > > 648dada55205fef0e4792a299b8f275135beb9d1

## Shortcuts

| Keys (Mac / Windows) | Action                                 |
| -------------------- | -------------------------------------- |
| `Opt+T` / `Alt+T`    | Start the picker; click or drag images |

The manifest key is a suggestion. Rebind a clash at `chrome://extensions/shortcuts`; the popup prints the bound key.

## When detection seems stuck

The batch pill shows how many seconds the current stage has run, and when a
batch fails it prints the failing item's reason. Before those two, a stage that
never returned and a stage that was merely slow looked the same, and a failed
batch said only `1 failed`.

Every wait now has a deadline, and a missed deadline is an error that names the
model and the stage:

| Wait                                          | Deadline |
| --------------------------------------------- | -------- |
| Page image download                           | 20 s     |
| Image decode                                  | 60 s     |
| Each model load                               | 180 s    |
| Each inference pass                           | 120 s    |
| One whole detection (service-worker watchdog) | 10 min   |

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
chrome.storage.local.set({ inferenceBackend: "wasm" }); // CPU: stable, slow
chrome.storage.local.set({ inferenceBackend: "webgpu" }); // GPU: fast
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

| File                        | Size  | Used for                         |
| --------------------------- | ----- | -------------------------------- |
| `comictextdetector.pt.onnx` | 94 MB | det map, one box per line        |
| `ppocr_v6_medium_rec.onnx`  | 76 MB | on-device line reading           |
| `ppocr_v6_dict.txt`         | 75 KB | recogniser charset               |
| `bubble.onnx`               | 11 MB | balloons, for grouping and erase |
| `aot_inpaint_512.onnx`      | 22 MB | filling erased ink               |

All are under `models/`. `scripts/prepare-assets.ts` fetches and verifies them; the bubble and inpaint models come out of the target project's release archive by byte range.

## Pipeline

| Stage     | Runs in        | What it does                                                              |
| --------- | -------------- | ------------------------------------------------------------------------- |
| Detect    | offscreen      | det map to one box per line, with the angle                               |
| Group     | offscreen      | merge lines into blocks, separate ruby, order columns                     |
| Read      | offscreen      | DeepSeek on a block crop and its grid, or PP-OCRv6 per line without a key |
| Translate | service worker | one DeepSeek request per block, cut to fit the source columns             |
| Erase     | offscreen      | AOT inpaint on labelled boxes; flat paper inside a balloon                |
| Place     | content script | erased page over the image, labels at source size and angle               |

Four contexts share one message protocol: `src/App.tsx` (popup and debug client), `src/content-script/pickImage.ts` and `overlay.ts` (picker and drawing), `src/background/index.ts` (queue, translation, erase gate; holds no model), `src/offscreen/main.ts` (sessions and inference).

## Scripts

| Command                  | What it does                               |
| ------------------------ | ------------------------------------------ |
| `npm run dev`            | popup in a browser tab                     |
| `npm run typecheck`      | `tsc`, no emit                             |
| `npm run build`          | build id, type-check, bundle to `dist/`    |
| `npm run prepare:assets` | fetch and verify models; runs before build |
| `npm run render:page`    | render one page's translation headlessly   |
| `npm run prompt:lab`     | compare prompts on a frozen detection      |
| `npm run regression`     | replay `fixtures/regression.json`          |
| `npm run grid:drift`     | measure labels against the ink             |

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
